import { fetchWithRetry, normalizeUsage, isTimeoutError } from "./fetch-utils.mjs";
import { streamResponse, accumulateStream } from "../core/streaming.mjs";

// Adapter for a locally served, OpenAI-compatible chat/completions endpoint
// (vLLM and compatible forks). It reuses the shared HTTP stack
// (fetchWithRetry/normalizeUsage from fetch-utils, streamResponse/accumulateStream
// from core/streaming) — the same one the OpenAI and Upstage adapters use — rather
// than introducing another HTTP client.
//
// What makes it "local":
//   - base URL and model id are explicit (no cloud default), bound to loopback
//     by the caller's config;
//   - authentication is OPTIONAL (local vLLM is usually open) — a bearer header
//     is sent only when an apiKey is configured;
//   - all parsing (reasoning/tool-call) is done SERVER-SIDE by the vLLM
//     `--reasoning-parser`/`--tool-call-parser` already validated per model, so
//     this client only transports the structured fields back out. It never
//     parses think-tags itself and never merges reasoning into content.
//
// Model-specific serving differences (deepseek_r1 vs qwen3 vs solar_open2
// parsers, enable_thinking, Mamba max-num-seqs, the Solar logits processor) live
// in the *server* launch (kserve.sh / kserve-solar.sh) and in the per-model
// config passed to this adapter — not in generic code here.

const DEFAULT_TIMEOUT_MS = 600_000; // local reasoning models can be slow; caller can lower

/**
 * Pull the reasoning trace out of a non-streaming message WITHOUT ever letting
 * it fall back to `content`. vLLM v0.32.0 exposes it as `message.reasoning`;
 * DeepSeek-R1-style APIs use `message.reasoning_content`. We check both, in that
 * order, and return null (unknown) when neither is present — never the content.
 */
export function extractReasoning(message) {
  if (!message || typeof message !== "object") return null;
  const r = message.reasoning ?? message.reasoning_content ?? null;
  return typeof r === "string" && r.length > 0 ? r : null;
}

/**
 * Keep the three reasoning-size signals separate and never conflate them:
 *   - reasoningChars: character length of the returned reasoning text (null if none);
 *   - providerReasoningTokens: usage.completion_tokens_details.reasoning_tokens as
 *     reported by the server, but ONLY when it is a positive number. A reported 0
 *     (or a missing field) is treated as UNKNOWN → null, never as a real zero,
 *     because some parsers (e.g. deepseek_r1 on Kanana) always report 0 even when
 *     thousands of reasoning characters were produced.
 */
export function reasoningMetrics(reasoningText, rawUsage) {
  const reasoningChars = typeof reasoningText === "string" && reasoningText.length > 0 ? reasoningText.length : null;
  let providerReasoningTokens = null;
  const details = rawUsage && typeof rawUsage === "object"
    ? rawUsage.completion_tokens_details ?? rawUsage.completionTokensDetails
    : null;
  const rt = details && typeof details === "object" ? details.reasoning_tokens ?? details.reasoningTokens : undefined;
  if (typeof rt === "number" && Number.isFinite(rt) && rt > 0) {
    providerReasoningTokens = rt;
  }
  return { reasoningChars, providerReasoningTokens };
}

/**
 * Classify a transport/API failure into a stable, machine-readable category so
 * the harness can keep infrastructure failures distinct from task failures.
 * Returns one of: auth | rate_limit | timeout | server_error | client_error |
 * context_length | network | unknown.
 */
export function classifyError({ status = null, error = null } = {}) {
  if (error && isTimeoutError(error)) return "timeout";
  if (typeof status === "number") {
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate_limit";
    if (status === 400 || status === 422) {
      return "client_error";
    }
    if (status >= 500) return "server_error";
    if (status >= 400) return "client_error";
  }
  if (error) return "network";
  return "unknown";
}

export function isContextLengthError(bodyText) {
  return /context length|maximum context|max_model_len|reduce the length|too long|exceeds? the? model/i.test(
    String(bodyText || "")
  );
}

async function readJsonResponse(response) {
  const data = await response.json();
  const choice = Array.isArray(data.choices) && data.choices[0] ? data.choices[0] : null;
  const message = choice?.message || {};
  const reasoning = extractReasoning(message);
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    reasoning,
    finishReason: choice?.finish_reason ?? null,
    usage: normalizeUsage(data.usage),
    reasoningMetrics: reasoningMetrics(reasoning, data.usage)
  };
}

export class LocalOpenAIAdapter {
  /**
   * @param {object} options
   * @param {string} options.model        served-model-name the server advertises
   * @param {string} options.baseUrl      e.g. http://127.0.0.1:8101/v1
   * @param {string} [options.apiKey]     optional bearer; omitted header when empty
   * @param {number} [options.temperature]
   * @param {number} [options.topP]
   * @param {number} [options.topK]            vLLM extension (sent top-level)
   * @param {number} [options.presencePenalty] vLLM extension (sent top-level)
   * @param {number} [options.maxTokens]       per-call output cap (max_tokens)
   * @param {number|null} [options.seed]
   * @param {object} [options.chatTemplateKwargs] e.g. { enable_thinking: true }
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRetries]
   */
  constructor(options = {}) {
    this.model = options.model || "local-model";
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:8101/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey || "";
    this.temperature = typeof options.temperature === "number" ? options.temperature : 0.6;
    this.topP = typeof options.topP === "number" ? options.topP : undefined;
    this.topK = typeof options.topK === "number" ? options.topK : undefined;
    this.presencePenalty = typeof options.presencePenalty === "number" ? options.presencePenalty : undefined;
    this.maxTokens = typeof options.maxTokens === "number" ? options.maxTokens : undefined;
    this.seed = typeof options.seed === "number" ? options.seed : null;
    this.chatTemplateKwargs =
      options.chatTemplateKwargs && typeof options.chatTemplateKwargs === "object" ? options.chatTemplateKwargs : null;
    this.timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries = typeof options.maxRetries === "number" && options.maxRetries >= 0 ? options.maxRetries : 2;
    // Per-run reasoning accounting. The agent loop consumes only content/toolCalls/
    // usage, so we accumulate reasoning signals here for provenance. All three are
    // kept separate; providerReasoningTokens stays null unless a positive count is
    // actually reported.
    this.reasoning = { calls: 0, callsWithReasoning: 0, totalReasoningChars: 0, providerReasoningTokens: null };
  }

  _recordReasoning(result) {
    this.reasoning.calls += 1;
    const chars = result?.reasoningMetrics?.reasoningChars;
    if (typeof chars === "number" && chars > 0) {
      this.reasoning.callsWithReasoning += 1;
      this.reasoning.totalReasoningChars += chars;
    }
    const prt = result?.reasoningMetrics?.providerReasoningTokens;
    if (typeof prt === "number" && prt > 0) {
      this.reasoning.providerReasoningTokens = (this.reasoning.providerReasoningTokens || 0) + prt;
    }
  }

  // Null when no reasoning was ever produced (e.g. a non-thinking model), so the
  // harness can tell "no reasoning" from "zero-length reasoning".
  reasoningSummary() {
    if (this.reasoning.calls === 0 || this.reasoning.callsWithReasoning === 0) {
      return { reasoningChars: null, providerReasoningTokens: this.reasoning.providerReasoningTokens, calls: this.reasoning.calls };
    }
    return {
      reasoningChars: this.reasoning.totalReasoningChars,
      providerReasoningTokens: this.reasoning.providerReasoningTokens, // null if never reliably reported
      calls: this.reasoning.calls,
      callsWithReasoning: this.reasoning.callsWithReasoning
    };
  }

  // Local servers need no key; the adapter is "configured" as long as it has a
  // base URL. (Availability against a live server is probed elsewhere.)
  isConfigured() {
    return typeof this.baseUrl === "string" && this.baseUrl.length > 0;
  }

  buildPayload({ messages, tools = [], stream = false, toolChoice }) {
    const payload = {
      model: this.model,
      messages,
      temperature: this.temperature,
      stream
    };
    if (this.topP !== undefined) payload.top_p = this.topP;
    if (this.topK !== undefined) payload.top_k = this.topK;
    if (this.presencePenalty !== undefined) payload.presence_penalty = this.presencePenalty;
    if (this.maxTokens !== undefined) payload.max_tokens = this.maxTokens;
    if (this.seed !== null) payload.seed = this.seed;
    if (this.chatTemplateKwargs) payload.chat_template_kwargs = this.chatTemplateKwargs;
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = toolChoice || "auto";
    }
    return payload;
  }

  async complete({ messages, tools = [], stream = false, onToken, toolChoice, signal } = {}) {
    if (!this.isConfigured()) {
      throw new Error(`Local model adapter has no base URL configured for model '${this.model}'`);
    }
    const payload = this.buildPayload({ messages, tools, stream, toolChoice });
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const doFetch = () => {
      // Per-attempt timeout; external `signal` (cancellation) is honored too.
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      return fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: combined
      });
    };

    let response;
    try {
      response = await fetchWithRetry(doFetch, { maxRetries: this.maxRetries });
    } catch (error) {
      const category = classifyError({ error });
      throw new Error(`Local model request failed [${category}] (${this.model} @ ${this.baseUrl}): ${error.message}`, {
        cause: error
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      let category = classifyError({ status: response.status });
      if (category === "client_error" && isContextLengthError(bodyText)) category = "context_length";
      throw new Error(
        `Local model API error [${category}] (${response.status}) from ${this.model}: ${bodyText.slice(0, 500)}`
      );
    }

    if (stream) {
      return accumulateStream(streamResponse(response), "openai", onToken);
    }
    const result = await readJsonResponse(response);
    this._recordReasoning(result);
    return result;
  }
}
