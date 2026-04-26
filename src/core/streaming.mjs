import { normalizeUsage } from "../model/fetch-utils.mjs";

// ── SSE line parser ─────────────────────────────────────────────────────────

export function parseSSEChunk(chunk) {
  const lines = chunk.split("\n");
  const result = { event: null, data: null };
  for (const line of lines) {
    if (line.startsWith("event:")) {
      result.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      result.data = line.slice(5).trim();
    }
  }
  return result;
}

// ── Raw SSE stream reader ───────────────────────────────────────────────────

export async function* streamResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const trimmed = event.trim();
      if (trimmed) yield trimmed;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

// ── Tool call delta merger (OpenAI format) ──────────────────────────────────

function mergeToolCall(collector, delta) {
  if (!Array.isArray(delta.tool_calls)) return;
  for (const tc of delta.tool_calls) {
    const idx = Number.isInteger(tc.index) ? tc.index : 0;
    if (!collector[idx]) {
      collector[idx] = {
        id: tc.id || `call_${idx}`,
        type: "function",
        function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" }
      };
      continue;
    }
    if (tc.id) collector[idx].id = tc.id;
    if (tc.function?.name) collector[idx].function.name = tc.function.name;
    if (tc.function?.arguments) collector[idx].function.arguments += tc.function.arguments;
  }
}

// ── Accumulate SSE stream into a final result ───────────────────────────────

export async function accumulateStream(events, format = "openai", onToken) {
  const toolCalls = [];
  let content = "";
  let usage = null;

  for await (const rawEvent of events) {
    const { data } = parseSSEChunk(rawEvent);
    if (!data || data === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (_e) {
      continue;
    }

    if (format === "gemini") {
      // Gemini streaming: candidates[0].content.parts[0].text
      const candidate = parsed.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (typeof text === "string" && text.length > 0) {
        content += text;
        if (typeof onToken === "function") onToken(text);
      }
      const geminiUsage = parsed.usageMetadata;
      if (geminiUsage) {
        usage = normalizeUsage({
          prompt_tokens: geminiUsage.promptTokenCount,
          completion_tokens: geminiUsage.candidatesTokenCount,
          total_tokens: geminiUsage.totalTokenCount
        });
      }
      continue;
    }

    // OpenAI format
    const chunkUsage = normalizeUsage(parsed.usage);
    if (chunkUsage) usage = chunkUsage;

    if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) continue;
    const delta = parsed.choices[0].delta || {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      if (typeof onToken === "function") onToken(delta.content);
    }
    mergeToolCall(toolCalls, delta);
  }

  return { content, toolCalls: toolCalls.filter(Boolean), usage };
}
