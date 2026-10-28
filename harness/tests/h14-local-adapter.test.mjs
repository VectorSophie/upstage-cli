import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  LocalOpenAIAdapter,
  extractReasoning,
  reasoningMetrics,
  classifyError,
  isContextLengthError
} from "../../src/model/local-openai-adapter.mjs";

// ── fetch stubbing ────────────────────────────────────────────────────────────
// Each test installs a handler that receives (url, opts) and returns either a
// Response or throws (to simulate transport errors). maxRetries:0 on the adapter
// keeps failing tests instant (no backoff delays).

const realFetch = globalThis.fetch;
let lastRequest = null;

function stub(handler) {
  globalThis.fetch = async (url, opts) => {
    lastRequest = { url: String(url), opts, body: opts?.body ? JSON.parse(opts.body) : null };
    return handler(url, opts);
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function msg(message, { usage, finish_reason = "stop" } = {}) {
  return { choices: [{ message, finish_reason }], usage };
}

beforeEach(() => { lastRequest = null; });
afterEach(() => { globalThis.fetch = realFetch; });

function mk(opts = {}) {
  return new LocalOpenAIAdapter({ model: "test-model", baseUrl: "http://127.0.0.1:8101/v1", maxRetries: 0, ...opts });
}

// ── pure helpers ───────────────────────────────────────────────────────────────

describe("extractReasoning", () => {
  it("prefers `reasoning` over `reasoning_content`", () => {
    assert.equal(extractReasoning({ reasoning: "A", reasoning_content: "B" }), "A");
  });
  it("falls back to `reasoning_content`", () => {
    assert.equal(extractReasoning({ reasoning_content: "B" }), "B");
  });
  it("returns null when neither present or empty", () => {
    assert.equal(extractReasoning({ content: "hi" }), null);
    assert.equal(extractReasoning({ reasoning: "" }), null);
    assert.equal(extractReasoning(null), null);
  });
  it("never returns content as reasoning", () => {
    assert.equal(extractReasoning({ content: "the answer" }), null);
  });
});

describe("reasoningMetrics", () => {
  it("reports character length, not tokens", () => {
    const m = reasoningMetrics("abcde", null);
    assert.equal(m.reasoningChars, 5);
  });
  it("provider reasoning tokens null when absent", () => {
    assert.equal(reasoningMetrics("abc", { completion_tokens: 10 }).providerReasoningTokens, null);
  });
  it("provider reasoning tokens null when reported as 0 (unreliable, e.g. deepseek_r1)", () => {
    const m = reasoningMetrics("abc", { completion_tokens_details: { reasoning_tokens: 0 } });
    assert.equal(m.providerReasoningTokens, null);
  });
  it("provider reasoning tokens kept when a positive count is reported (e.g. qwen3)", () => {
    const m = reasoningMetrics("abc", { completion_tokens_details: { reasoning_tokens: 123 } });
    assert.equal(m.providerReasoningTokens, 123);
  });
  it("no reasoning text → reasoningChars null, not 0", () => {
    assert.equal(reasoningMetrics(null, null).reasoningChars, null);
  });
});

describe("classifyError", () => {
  it("maps HTTP statuses", () => {
    assert.equal(classifyError({ status: 401 }), "auth");
    assert.equal(classifyError({ status: 403 }), "auth");
    assert.equal(classifyError({ status: 429 }), "rate_limit");
    assert.equal(classifyError({ status: 400 }), "client_error");
    assert.equal(classifyError({ status: 500 }), "server_error");
    assert.equal(classifyError({ status: 503 }), "server_error");
  });
  it("maps abort/timeout errors", () => {
    const e = new Error("the operation was aborted"); e.name = "AbortError";
    assert.equal(classifyError({ error: e }), "timeout");
  });
  it("other errors → network", () => {
    assert.equal(classifyError({ error: new Error("ECONNREFUSED") }), "network");
  });
  it("isContextLengthError recognizes vLLM phrasing", () => {
    assert.ok(isContextLengthError("This model's maximum context length is 8192 tokens"));
    assert.ok(!isContextLengthError("some other 400"));
  });
});

// ── complete(): happy paths ──────────────────────────────────────────────────

describe("LocalOpenAIAdapter.complete — text and tools", () => {
  it("ordinary text completion: content, no tool calls, usage normalized", async () => {
    stub(() => json(msg({ role: "assistant", content: "Hello" }, { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })));
    const r = await mk().complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.content, "Hello");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.reasoning, null);
    assert.equal(r.finishReason, "stop");
    assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5, cost: 0 });
  });

  it("single structured tool call", async () => {
    const tc = [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt"}' } }];
    stub(() => json(msg({ role: "assistant", content: "", tool_calls: tc }, { finish_reason: "tool_calls" })));
    const r = await mk().complete({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "write_file" } }] });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].function.name, "write_file");
    assert.equal(r.finishReason, "tool_calls");
    // tools present → tool_choice auto sent
    assert.equal(lastRequest.body.tool_choice, "auto");
  });

  it("multiple tool calls preserved", async () => {
    const tc = [
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
      { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } }
    ];
    stub(() => json(msg({ role: "assistant", content: "", tool_calls: tc }, { finish_reason: "tool_calls" })));
    const r = await mk().complete({ messages: [], tools: [{ type: "function", function: { name: "read_file" } }] });
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.toolCalls[1].id, "c2");
  });

  it("tool-result continuation: a role:tool message is transported unchanged", async () => {
    stub(() => json(msg({ role: "assistant", content: "final answer" })));
    const messages = [
      { role: "user", content: "x" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "42" }
    ];
    const r = await mk().complete({ messages });
    assert.equal(r.content, "final answer");
    assert.equal(lastRequest.body.messages.find((m) => m.role === "tool").tool_call_id, "c1");
  });

  it("malformed tool arguments are passed through as the raw string (not parsed/crashed)", async () => {
    const tc = [{ id: "c1", type: "function", function: { name: "f", arguments: "{not json" } }];
    stub(() => json(msg({ role: "assistant", content: "", tool_calls: tc }, { finish_reason: "tool_calls" })));
    const r = await mk().complete({ messages: [] });
    assert.equal(r.toolCalls[0].function.arguments, "{not json");
  });
});

// ── complete(): reasoning ─────────────────────────────────────────────────────

describe("LocalOpenAIAdapter.complete — reasoning handling", () => {
  it("extracts reasoning into its own field (vLLM `reasoning`)", async () => {
    stub(() => json(msg({ role: "assistant", content: "answer", reasoning: "step 1, step 2" })));
    const r = await mk().complete({ messages: [] });
    assert.equal(r.content, "answer");
    assert.equal(r.reasoning, "step 1, step 2");
    assert.equal(r.reasoningMetrics.reasoningChars, "step 1, step 2".length);
  });

  it("missing reasoning field → reasoning null, content intact", async () => {
    stub(() => json(msg({ role: "assistant", content: "answer" })));
    const r = await mk().complete({ messages: [] });
    assert.equal(r.reasoning, null);
    assert.equal(r.content, "answer");
  });

  it("truncated reasoning (finish_reason=length) keeps content and does not fabricate reasoning", async () => {
    // Server returned an unfinished think as content with no separate reasoning.
    stub(() => json(msg({ role: "assistant", content: "Thinking Process: ..." }, { finish_reason: "length" })));
    const r = await mk().complete({ messages: [] });
    assert.equal(r.finishReason, "length");
    assert.equal(r.content, "Thinking Process: ...");
    assert.equal(r.reasoning, null); // never guessed
  });

  it("aggregates reasoning across calls; providerReasoningTokens stays null when only 0s reported", async () => {
    const a = mk();
    stub(() => json(msg({ role: "assistant", content: "x", reasoning: "abcd" }, { usage: { completion_tokens_details: { reasoning_tokens: 0 } } })));
    await a.complete({ messages: [] });
    await a.complete({ messages: [] });
    const s = a.reasoningSummary();
    assert.equal(s.reasoningChars, 8); // 4 + 4 characters
    assert.equal(s.providerReasoningTokens, null);
    assert.equal(s.calls, 2);
  });

  it("non-thinking model (no reasoning ever) → reasoningSummary.reasoningChars null", async () => {
    const a = mk();
    stub(() => json(msg({ role: "assistant", content: "answer" })));
    await a.complete({ messages: [] });
    assert.equal(a.reasoningSummary().reasoningChars, null);
  });
});

// ── complete(): usage edge cases ──────────────────────────────────────────────

describe("LocalOpenAIAdapter.complete — usage edge cases", () => {
  it("null usage → usage null (unknown, not zero)", async () => {
    stub(() => json(msg({ role: "assistant", content: "x" })));
    const r = await mk().complete({ messages: [] });
    assert.equal(r.usage, null);
  });
  it("positive reasoning_tokens surfaced in reasoningMetrics", async () => {
    stub(() => json(msg({ role: "assistant", content: "x", reasoning: "yy" }, { usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 7 } } })));
    const r = await mk().complete({ messages: [] });
    assert.equal(r.reasoningMetrics.providerReasoningTokens, 7);
  });
});

// ── complete(): error classification ──────────────────────────────────────────

describe("LocalOpenAIAdapter.complete — error classification", () => {
  it("HTTP 500 → throws server_error", async () => {
    stub(() => new Response("boom", { status: 500 }));
    await assert.rejects(() => mk().complete({ messages: [] }), /\[server_error\].*500/);
  });
  it("HTTP 401 → throws auth", async () => {
    stub(() => new Response("nope", { status: 401 }));
    await assert.rejects(() => mk().complete({ messages: [] }), /\[auth\]/);
  });
  it("HTTP 400 with context-length body → context_length", async () => {
    stub(() => new Response("maximum context length is 8192", { status: 400 }));
    await assert.rejects(() => mk().complete({ messages: [] }), /\[context_length\]/);
  });
  it("transport timeout → throws timeout", async () => {
    stub(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    await assert.rejects(() => mk().complete({ messages: [] }), /\[timeout\]/);
  });
});

// ── payload construction ──────────────────────────────────────────────────────

describe("LocalOpenAIAdapter — payload and auth", () => {
  it("no apiKey → no Authorization header", async () => {
    stub(() => json(msg({ role: "assistant", content: "x" })));
    await mk().complete({ messages: [] });
    assert.ok(!("Authorization" in lastRequest.opts.headers));
  });
  it("apiKey → Bearer header sent", async () => {
    stub(() => json(msg({ role: "assistant", content: "x" })));
    await mk({ apiKey: "secret" }).complete({ messages: [] });
    assert.equal(lastRequest.opts.headers.Authorization, "Bearer secret");
  });
  it("vendor sampling + chat_template_kwargs included only when set", async () => {
    stub(() => json(msg({ role: "assistant", content: "x" })));
    await mk({ temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5, maxTokens: 4096, chatTemplateKwargs: { enable_thinking: false } })
      .complete({ messages: [] });
    const b = lastRequest.body;
    assert.equal(b.temperature, 0.6);
    assert.equal(b.top_p, 0.95);
    assert.equal(b.top_k, 20);
    assert.equal(b.presence_penalty, 1.5);
    assert.equal(b.max_tokens, 4096);
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  });
  it("omits optional sampling fields when unset", async () => {
    stub(() => json(msg({ role: "assistant", content: "x" })));
    await mk().complete({ messages: [] });
    const b = lastRequest.body;
    assert.ok(!("top_k" in b));
    assert.ok(!("presence_penalty" in b));
    assert.ok(!("chat_template_kwargs" in b));
  });
  it("trailing slash in baseUrl is normalized", () => {
    assert.equal(mk({ baseUrl: "http://h/v1/" }).baseUrl, "http://h/v1");
  });
});

// ── P1-B: response validation ────────────────────────────────────────────────

import { validateChatResponse, ProtocolError } from "../../src/model/local-openai-adapter.mjs";

describe("validateChatResponse — structural validation (P1-B)", () => {
  const ok = (message, extra = {}) => ({ choices: [{ message, finish_reason: "stop" }], ...extra });

  it("accepts a normal content message", () => {
    const r = validateChatResponse(ok({ role: "assistant", content: "hi" }));
    assert.equal(r.content, "hi");
  });
  it("accepts null content when tool calls are present", () => {
    const r = validateChatResponse({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    assert.equal(r.content, "");
    assert.equal(r.toolCalls.length, 1);
  });
  it("accepts null content when reasoning is present", () => {
    const r = validateChatResponse({ choices: [{ message: { role: "assistant", content: null, reasoning: "thinking" }, finish_reason: "length" }] });
    assert.equal(r.reasoning, "thinking");
  });
  it("rejects missing choices", () => {
    assert.throws(() => validateChatResponse({ usage: {} }), ProtocolError);
  });
  it("rejects empty choices array", () => {
    assert.throws(() => validateChatResponse({ choices: [] }), ProtocolError);
  });
  it("rejects a choice with no message object", () => {
    assert.throws(() => validateChatResponse({ choices: [{ finish_reason: "stop" }] }), ProtocolError);
  });
  it("rejects non-array tool_calls", () => {
    assert.throws(() => validateChatResponse(ok({ role: "assistant", content: "x", tool_calls: {} })), ProtocolError);
  });
  it("rejects a tool call missing function.name", () => {
    assert.throws(() => validateChatResponse(ok({ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { arguments: "{}" } }] })), ProtocolError);
  });
  it("rejects non-string content", () => {
    assert.throws(() => validateChatResponse(ok({ role: "assistant", content: { a: 1 } })), ProtocolError);
  });
  it("rejects a wholly empty turn (no content/tools/reasoning) when not truncated", () => {
    assert.throws(() => validateChatResponse({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] }), ProtocolError);
  });
  it("does NOT reject an empty turn when finish_reason=length (truncation handled upstream)", () => {
    const r = validateChatResponse({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "length" }] });
    assert.equal(r.finishReason, "length");
    assert.equal(r.content, "");
  });
  it("defaults absent tool-call arguments to '{}' rather than rejecting", () => {
    const r = validateChatResponse(ok({ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "f" } }] }));
    assert.equal(r.toolCalls[0].function.arguments, "{}");
  });
  it("complete() surfaces a malformed 200 as a [protocol] error", async () => {
    stub(() => json({ not: "an openai response" }));
    await assert.rejects(() => mk().complete({ messages: [] }), /\[protocol\]/);
  });
});

// ── P1-C: wall-clock deadline ────────────────────────────────────────────────

describe("LocalOpenAIAdapter — deadline enforcement (P1-C)", () => {
  it("refuses to start a request once the deadline has passed → [deadline]", async () => {
    let called = false;
    stub(() => { called = true; return json(msg({ role: "assistant", content: "x" })); });
    const a = mk({ deadline: Date.now() - 1 });
    await assert.rejects(() => a.complete({ messages: [] }), /\[deadline\]/);
    assert.equal(called, false, "must not issue the HTTP request after the deadline");
  });

  it("caps the per-request timeout to the remaining budget", async () => {
    let seenTimeout = null;
    // Capture the AbortSignal's timeout by observing when it aborts.
    globalThis.fetch = async (_url, opts) => {
      return await new Promise((_resolve, reject) => {
        const t0 = Date.now();
        opts.signal.addEventListener("abort", () => { seenTimeout = Date.now() - t0; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
    };
    // timeoutMs huge, but only 150ms of budget remains → request must abort ~150ms.
    const a = mk({ timeoutMs: 600000, deadline: Date.now() + 150, maxRetries: 0 });
    await assert.rejects(() => a.complete({ messages: [] }), /\[deadline\]/);
    assert.ok(seenTimeout !== null && seenTimeout < 2000, `aborted by remaining-budget cap (~${seenTimeout}ms)`);
  });

  it("does not retry when the backoff would cross the deadline", async () => {
    let calls = 0;
    stub(() => { calls += 1; return new Response("busy", { status: 503 }); });
    // 503 is retriable, but initialRetryDelay 1000ms and only 50ms budget → no retry.
    const a = mk({ maxRetries: 3, initialRetryDelayMs: 1000, deadline: Date.now() + 50 });
    await a.complete({ messages: [] }).catch(() => {});
    assert.equal(calls, 1, "must not sleep past the deadline to retry");
  });

  it("honors caller cancellation → [cancelled]", async () => {
    const controller = new AbortController();
    globalThis.fetch = async (_url, opts) => new Promise((_r, reject) => {
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const a = mk({ maxRetries: 0, timeoutMs: 60000 });
    const p = a.complete({ messages: [], signal: controller.signal });
    controller.abort();
    await assert.rejects(() => p, /\[cancelled\]/);
  });

  it("a genuine request timeout within budget classifies as [timeout], not [deadline]", async () => {
    stub(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    const a = mk({ maxRetries: 0, timeoutMs: 20 }); // no deadline set → not a budget hit
    await assert.rejects(() => a.complete({ messages: [] }), /\[timeout\]/);
  });

  it("tracks lastFinishReason from the most recent completion", async () => {
    const a = mk();
    stub(() => json(msg({ role: "assistant", content: "x" }, { finish_reason: "length" })));
    await a.complete({ messages: [] });
    assert.equal(a.lastFinishReason, "length");
  });
});
