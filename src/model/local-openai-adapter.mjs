import { normalizeUsage, isTimeoutError, isRetriableStatus, delay } from "./fetch-utils.mjs";
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
  if (error && (error.name === "ProtocolError" || error.category === "protocol")) return "protocol";
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

// A structurally invalid but HTTP-200 response is a PROTOCOL violation, not a
// normal completion and not a transport error. Thrown so the caller tags it
// [protocol] and the harness records it as an error (never a silent empty DONE).
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
    this.category = "protocol";
  }
}

// Finish reasons that mean the generation did NOT complete normally. Exported so
// the agent loop can refuse to treat them as an ordinary DONE response.
export const TRUNCATION_FINISH_REASONS = new Set(["length", "content_filter"]);

/**
 * Validate an OpenAI-compatible chat/completions body and project the fields we
 * use. Rejects (ProtocolError) a missing/empty `choices`, a missing `message`
 * object, a non-array or malformed `tool_calls`, a non-string/non-null `content`,
 * and a wholly empty turn (no content, no tool calls, no reasoning) UNLESS the
 * finish_reason marks it as a legitimate truncation (handled upstream). Null
 * content is preserved as valid when tool calls or reasoning accompany it.
 */
export function validateChatResponse(data) {
  if (!data || typeof data !== "object") {
    throw new ProtocolError("response body is not a JSON object");
  }
  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ProtocolError("response has no `choices`");
  }
  const choice = data.choices[0];
  if (!choice || typeof choice !== "object" || !choice.message || typeof choice.message !== "object") {
    throw new ProtocolError("first choice has no `message` object");
  }
  const message = choice.message;
  const finishReason = choice.finish_reason ?? null;

  if (message.content !== undefined && message.content !== null && typeof message.content !== "string") {
    throw new ProtocolError(`message.content has invalid type (${typeof message.content})`);
  }

  let toolCalls = [];
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) {
      throw new ProtocolError("message.tool_calls is not an array");
    }
    for (const tc of message.tool_calls) {
      if (!tc || typeof tc !== "object" || !tc.function || typeof tc.function !== "object") {
        throw new ProtocolError("malformed tool call (missing function object)");
      }
      if (typeof tc.function.name !== "string" || tc.function.name.length === 0) {
        throw new ProtocolError("malformed tool call (missing function.name)");
      }
      // arguments is an OpenAI JSON *string*; absence is tolerated (defaulted to
      // "{}"), but a non-string arguments field is a protocol violation. We do
      // NOT validate that the string parses — malformed JSON args are handled
      // (and classified) downstream by the tool executor, not hidden here.
      if (tc.function.arguments !== undefined && tc.function.arguments !== null && typeof tc.function.arguments !== "string") {
        throw new ProtocolError("malformed tool call (function.arguments is not a string)");
      }
      if (tc.function.arguments === undefined || tc.function.arguments === null) {
        tc.function.arguments = "{}";
      }
    }
    toolCalls = message.tool_calls;
  }

  const reasoning = extractReasoning(message);
  const hasContent = typeof message.content === "string" && message.content.length > 0;
  if (!hasContent && toolCalls.length === 0 && !reasoning && !TRUNCATION_FINISH_REASONS.has(finishReason)) {
    throw new ProtocolError(
      `empty response (no content, tool calls, or reasoning; finish_reason=${finishReason ?? "absent"})`
    );
  }

  return {
    // Null content is legitimate alongside tool calls / reasoning; normalize to
    // "" for the loop, which treats content as a string.
    content: typeof message.content === "string" ? message.content : "",
    toolCalls,
    reasoning,
    finishReason,
    usage: normalizeUsage(data.usage),
    reasoningMetrics: reasoningMetrics(reasoning, data.usage)
  };
}

async function readJsonResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new ProtocolError(`response body is not valid JSON: ${err.message}`);
  }
  return validateChatResponse(data);
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
    // Absolute wall-clock deadline (epoch ms) for the whole agent run. When set,
    // no single request may outlive it: each request's effective timeout is
    // min(timeoutMs, remaining), retries never sleep past it, and once it is
    // reached the adapter stops instead of starting another request. null = no
    // extra cap beyond timeoutMs.
    this.deadline = typeof options.deadline === "number" && options.deadline > 0 ? options.deadline : null;
    this.initialRetryDelayMs =
      typeof options.initialRetryDelayMs === "number" && options.initialRetryDelayMs >= 0 ? options.initialRetryDelayMs : 1000;
    // The provider finish_reason of the most recent completion, for provenance.
    this.lastFinishReason = null;
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

  // Remaining wall-clock budget (ms) before the agent-run deadline, or Infinity
  // when no deadline is set.
  _remainingMs() {
    return this.deadline === null ? Infinity : this.deadline - Date.now();
  }

  async complete({ messages, tools = [], stream = false, onToken, toolChoice, signal } = {}) {
    if (!this.isConfigured()) {
      throw new Error(`Local model adapter has no base URL configured for model '${this.model}'`);
    }
    const payload = this.buildPayload({ messages, tools, stream, toolChoice });
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this._fetchWithDeadline(payload, headers, signal);

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
    let result;
    try {
      result = await readJsonResponse(response);
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw new Error(`Local model protocol error [protocol] from ${this.model}: ${error.message}`, { cause: error });
      }
      throw error;
    }
    this.lastFinishReason = result.finishReason ?? null;
    this._recordReasoning(result);
    return result;
  }

  /**
   * Deadline- and cancellation-aware fetch with bounded retries. Each attempt is
   * aborted at min(timeoutMs, remaining-budget); retries respect the same
   * deadline (we never sleep past it and never start an attempt once it has
   * passed). A deadline hit is thrown as [deadline] (agent-budget exhaustion,
   * distinct from a server [timeout] or [server_error]) so the caller can tell
   * "we ran out of time" from "the server failed".
   */
  async _fetchWithDeadline(payload, headers, externalSignal) {
    const body = JSON.stringify(payload);
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const remaining = this._remainingMs();
      if (remaining <= 0) {
        throw new Error(
          `Local model request failed [deadline] (${this.model} @ ${this.baseUrl}): agent-run budget exhausted before request`,
          { cause: lastError || undefined }
        );
      }
      if (externalSignal?.aborted) {
        throw new Error(`Local model request failed [cancelled] (${this.model} @ ${this.baseUrl}): caller cancelled`);
      }
      const perAttemptTimeout = Math.max(1, Math.min(this.timeoutMs, remaining));
      // Explicit controller + a CLEARED timer (rather than AbortSignal.timeout),
      // so a fast response/cancellation leaves no long-lived timer dangling in
      // the event loop — important for deterministic teardown.
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort(externalSignal.reason);
      if (externalSignal) externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("request timed out", "TimeoutError")); }, perAttemptTimeout);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body, signal: controller.signal });
        if (isRetriableStatus(response.status) && attempt < this.maxRetries) {
          lastError = new Error(`retriable status ${response.status}`);
          if (!(await this._backoffWithinDeadline(attempt))) return response; // no time to retry → return as-is
          continue;
        }
        return response;
      } catch (error) {
        // `timedOut` marks our own per-attempt timer firing (vs an external abort).
        if (timedOut && !isTimeoutError(error)) error = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
        // Distinguish a deadline/cancellation abort from a genuine server timeout.
        if (externalSignal?.aborted) {
          throw new Error(`Local model request failed [cancelled] (${this.model} @ ${this.baseUrl}): caller cancelled`, { cause: error });
        }
        if (isTimeoutError(error) && this.deadline !== null && Date.now() >= this.deadline) {
          throw new Error(
            `Local model request failed [deadline] (${this.model} @ ${this.baseUrl}): exceeded agent-run budget`,
            { cause: error }
          );
        }
        lastError = error;
        const retriable = isTimeoutError(error);
        if (!retriable || attempt >= this.maxRetries) {
          const category = classifyError({ error });
          throw new Error(`Local model request failed [${category}] (${this.model} @ ${this.baseUrl}): ${error.message}`, { cause: error });
        }
        if (!(await this._backoffWithinDeadline(attempt))) {
          throw new Error(`Local model request failed [deadline] (${this.model} @ ${this.baseUrl}): no budget left to retry`, { cause: error });
        }
      } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
    const category = classifyError({ error: lastError });
    throw new Error(`Local model request failed [${category}] (${this.model} @ ${this.baseUrl}) after retries: ${lastError?.message ?? "unknown"}`, { cause: lastError || undefined });
  }

  // Sleep the exponential backoff for `attempt`, but only if it fits inside the
  // remaining budget. Returns false (don't retry) when it would cross the deadline.
  async _backoffWithinDeadline(attempt) {
    const backoff = this.initialRetryDelayMs * 2 ** attempt;
    if (this.deadline !== null && Date.now() + backoff >= this.deadline) return false;
    if (backoff > 0) await delay(backoff);
    return true;
  }
}
