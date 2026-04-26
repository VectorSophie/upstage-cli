import { fetchWithRetry, normalizeUsage } from "./fetch-utils.mjs";
import { streamResponse, accumulateStream } from "../core/streaming.mjs";

const DEFAULT_MODEL = "gpt-4o";

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

export class OpenAIAdapter {
  constructor(options = {}) {
    this.model = options.model || DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
    this.baseUrl = options.baseUrl || "https://api.openai.com/v1";
    this.temperature = typeof options.temperature === "number" ? options.temperature : 0.1;
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  async complete({ messages, tools = [], stream = true, onToken }) {
    if (!this.isConfigured()) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const payload = {
      model: this.model,
      messages,
      temperature: this.temperature,
      stream
    };
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
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
      throw new Error(`OpenAI API error (${response.status}): ${bodyText}`);
    }

    if (stream) {
      return accumulateStream(streamResponse(response), "openai", onToken);
    }
    return readJsonResponse(response);
  }
}
