import { fetchWithRetry, normalizeUsage } from "./fetch-utils.mjs";
import { streamResponse, accumulateStream } from "../core/streaming.mjs";

const DEFAULT_BASE_URL = process.env.UPSTAGE_API_BASE_URL || "https://api.upstage.ai/v1";
const DEFAULT_MODEL = process.env.UPSTAGE_MODEL || "solar-pro4";

async function readJsonResponse(response) {
  const data = await response.json();
  const choice = Array.isArray(data.choices) && data.choices[0] ? data.choices[0] : null;
  const message = choice?.message || {};
  return {
    content: message.content || "",
    toolCalls: message.tool_calls || [],
    usage: normalizeUsage(data.usage)
  };
}

const VALID_REASONING_EFFORTS = new Set(["low", "high"]);

export class UpstageAdapter {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.model = options.model || DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.UPSTAGE_API_KEY || "";
    this.temperature = typeof options.temperature === "number" ? options.temperature : 0.1;
    // Solar Pro2 is a hybrid reasoning model with a real reasoning_effort
    // switch (Upstage's own Solar Pro2 Prompting Handbook: "high" makes it
    // reason step-by-step with verification, ~3x slower; "low" skips that
    // for simple tasks, ~70% fewer output tokens). null/"auto" omits the
    // field entirely and lets the model pick its own default — this is
    // the one lever no other coding agent has, since none of them run on
    // a model with this exact hybrid-effort API.
    this.reasoningEffort = VALID_REASONING_EFFORTS.has(options.reasoningEffort) ? options.reasoningEffort : null;
  }

  setReasoningEffort(value) {
    this.reasoningEffort = VALID_REASONING_EFFORTS.has(value) ? value : null;
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  async complete({ messages, tools = [], stream = true, onToken, toolChoice }) {
    if (!this.isConfigured()) {
      throw new Error("UPSTAGE_API_KEY is not configured");
    }

    // Use "required" only on the very first user turn (no tool history yet) when the
    // last user message is clearly an action request. This stops Solar Pro2 from
    // describing what it would do instead of doing it.
    const ACTION_WORDS = /\b(read|write|create|edit|fix|add|run|list|find|search|delete|rename|move|show|check)\b/i;
    const hasToolResults = messages.some((m) => m.role === "tool");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const isActionPrompt = typeof lastUser?.content === "string" && ACTION_WORDS.test(lastUser.content);
    const resolvedToolChoice =
      toolChoice || (tools.length > 0 && !hasToolResults && isActionPrompt ? "required" : "auto");

    const payload = {
      model: this.model,
      messages,
      tools,
      tool_choice: resolvedToolChoice,
      temperature: this.temperature,
      stream
    };
    if (this.reasoningEffort) {
      payload.reasoning_effort = this.reasoningEffort;
    }

    const response = await fetchWithRetry(() =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })
    );

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Upstage API error (${response.status}): ${bodyText}`);
    }

    if (stream) {
      return accumulateStream(streamResponse(response), "openai", onToken);
    }
    return readJsonResponse(response);
  }
}
