import { fetchWithRetry, normalizeUsage } from "./fetch-utils.mjs";
import { streamResponse, accumulateStream } from "../core/streaming.mjs";

// 3.3.0 Thread D, Task D.2: gemini-2.0-flash was stale (this codebase's
// pre-existing default) — gemini-3.8-flash is the current stable model
// with confirmed text/image/video/audio/PDF input, which is what the
// vision sidecar (Task D.3) needs.
export const DEFAULT_MODEL = "gemini-3.8-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function toGeminiRole(role) {
  if (role === "assistant") return "model";
  if (role === "tool") return "user";
  return "user";
}

// 3.3.0 Thread D, Task D.1's provider-neutral content-part shape, as far as
// this adapter accepts it: `msg.content` may be a plain string (unchanged
// behavior) or an array of `{type:"text", text}` / `{type:"image",
// source:{type:"base64", data, mimeType}}` parts. Only `type:"base64"`
// image sources are accepted here — resolving an evidence-store file to
// base64 happens once, at the tool boundary (inspect_image, Task D.3), so
// this stays a pure, synchronous function with no file I/O of its own.
function toGeminiParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content ?? "");
    return text ? [{ text }] : [];
  }
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push({ text: part.text });
    } else if (part?.type === "image" && part.source?.type === "base64") {
      parts.push({ inlineData: { mimeType: part.source.mimeType, data: part.source.data } });
    }
  }
  return parts;
}

export function toGeminiMessages(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // Gemini uses systemInstruction separately
    if (msg.role === "tool") {
      // Tool result — wrap as function response
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: msg.name || "tool", response: { output: msg.content || "" } } }]
      });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      contents.push({
        role: "model",
        parts: msg.tool_calls.map((tc) => ({
          functionCall: {
            name: tc.function?.name || "",
            args: (() => {
              try { return JSON.parse(tc.function?.arguments || "{}"); }
              catch (_e) { return {}; }
            })()
          }
        }))
      });
      continue;
    }
    const parts = toGeminiParts(msg.content);
    if (parts.length > 0) {
      contents.push({ role: toGeminiRole(msg.role), parts });
    }
  }
  return contents;
}

function fromGeminiResponse(body) {
  const candidate = Array.isArray(body.candidates) ? body.candidates[0] : null;
  const parts = candidate?.content?.parts ?? [];
  let content = "";
  const toolCalls = [];

  for (const part of parts) {
    if (typeof part.text === "string") {
      content += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name || "",
          arguments: JSON.stringify(part.functionCall.args ?? {})
        }
      });
    }
  }

  const usage = normalizeUsage(body.usageMetadata
    ? {
        prompt_tokens: body.usageMetadata.promptTokenCount,
        completion_tokens: body.usageMetadata.candidatesTokenCount,
        total_tokens: body.usageMetadata.totalTokenCount
      }
    : null
  );

  return { content, toolCalls, usage };
}

export class GeminiAdapter {
  constructor(options = {}) {
    this.model = options.model || DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
    this.temperature = typeof options.temperature === "number" ? options.temperature : 0.1;
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  async complete({ messages, tools = [], stream = true, onToken }) {
    if (!this.isConfigured()) {
      throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is not configured");
    }

    const systemMsg = messages.find((m) => m.role === "system");
    const contents = toGeminiMessages(messages);

    const payload = {
      contents,
      generationConfig: { temperature: this.temperature, maxOutputTokens: 8192 }
    };
    if (systemMsg) {
      payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }
    if (tools.length > 0) {
      payload.tools = [{
        functionDeclarations: tools
          .filter((t) => t.type === "function")
          .map((t) => ({
            name: t.function?.name,
            description: t.function?.description || "",
            parameters: t.function?.parameters || { type: "object", properties: {} }
          }))
      }];
    }

    const endpoint = stream
      ? `${BASE_URL}/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`
      : `${BASE_URL}/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetchWithRetry(() =>
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${bodyText}`);
    }

    if (stream) {
      return accumulateStream(streamResponse(response), "gemini", onToken);
    }

    const body = await response.json();
    return fromGeminiResponse(body);
  }
}
