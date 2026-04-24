import test from "node:test";
import assert from "node:assert/strict";

import { UpstageAdapter } from "../src/model/upstage-adapter.mjs";
import { runAgentLoop, collectAgentLoop } from "../src/agent/loop.mjs";
import { createSession } from "../src/runtime/session.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";

function withImmediateTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => {
    callback(...args);
    return 0;
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout;
    });
}

test("upstage adapter retries transient 429 responses", async () => {
  const adapter = new UpstageAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    model: "solar-pro2"
  });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Content-Type": "text/plain" }
      });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
              tool_calls: []
            }
          }
        ],
        usage: {
          total_tokens: 128
        }
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const result = await withImmediateTimers(() =>
      adapter.complete({
        messages: [{ role: "user", content: "hello" }],
        stream: false
      })
    );

    assert.equal(calls, 3);
    assert.equal(result.content, "ok");
    assert.equal(result.usage.totalTokens, 128);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstage adapter retries timeout errors", async () => {
  const adapter = new UpstageAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    model: "solar-pro2"
  });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const timeoutError = new Error("Request timed out");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok after timeout",
              tool_calls: []
            }
          }
        ],
        usage: {
          total_tokens: 256
        }
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const result = await withImmediateTimers(() =>
      adapter.complete({
        messages: [{ role: "user", content: "hello" }],
        stream: false
      })
    );

    assert.equal(calls, 2);
    assert.equal(result.content, "ok after timeout");
    assert.equal(result.usage.totalTokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent loop emits SYSTEM_WARNING after crossing token budget threshold", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const session = createSession(process.cwd());
  let callCount = 0;
  const adapter = {
    model: "solar-pro2",
    isConfigured() {
      return true;
    },
    async complete() {
      callCount += 1;
      return {
        content: `turn-${callCount}`,
        toolCalls: [],
        usage: {
          totalTokens: callCount === 1 ? 500000 : 350000
        }
      };
    }
  };

const events = [];
const runOnce = async (input) => {
  const gen = runAgentLoop({
    input,
    registry,
    cwd: process.cwd(),
    adapter,
    stream: false,
    session,
    runtimeCache: {}
  });
  const collected = await collectAgentLoop(gen);
  events.push(...collected.events);
  return collected.result;
};

const first = await runOnce("first turn");
const second = await runOnce("second turn");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

const tokenEvents = events.filter((event) => event.type === "token_usage");
const warningEvents = events.filter((event) => event.type === "system_warning");

  assert.equal(tokenEvents.length, 2);
  assert.equal(warningEvents.length, 1);
  assert.equal(warningEvents[0].code, "TOKEN_CONTEXT_HIGH");
  assert.ok(warningEvents[0].usage.totalTokens > warningEvents[0].usage.threshold);

  const runtimeWarning = session.runtimeEvents.find((event) => event.type === "SYSTEM_WARNING");
  assert.ok(runtimeWarning);
});

test("agent loop retries once with compacted context on context_length_exceeded", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const session = createSession(process.cwd());
  let callCount = 0;
  const adapter = {
    model: "solar-pro2",
    isConfigured() {
      return true;
    },
    async complete() {
      callCount += 1;
      if (callCount === 1) {
        throw new Error(
          "Upstage API error (400): {\"error\": {\"code\": \"context_length_exceeded\", \"message\": \"maximum context length exceeded\"}}"
        );
      }
      return {
        content: "retry-success",
        toolCalls: [],
        usage: {
          totalTokens: 1200
        }
      };
    }
  };

const gen = runAgentLoop({
  input: "large request",
  registry,
  cwd: process.cwd(),
  adapter,
  stream: false,
  session,
  runtimeCache: {}
});
const { result, events: collectedEvents } = await collectAgentLoop(gen);

assert.equal(result.ok, true);
assert.equal(result.response, "retry-success");
assert.equal(callCount, 2);
assert.ok(collectedEvents.some((event) => event.type === "system_warning" && event.code === "CONTEXT_COMPACT_RETRY"));
});

test("agent loop drops dangling assistant tool_calls from prior history before model call", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const session = createSession(process.cwd());
  session.history.push({
    at: Date.now(),
    role: "assistant",
    content: "pending tool",
    tool_calls: [
      {
        id: "stale-tool-id",
        type: "function",
        function: { name: "echo", arguments: "{}" }
      }
    ]
  });

  const adapter = {
    model: "solar-pro2",
    isConfigured() {
      return true;
    },
    async complete({ messages }) {
      const danglingAssistant = messages.find(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.some((call) => call.id === "stale-tool-id")
      );
      assert.equal(danglingAssistant, undefined);
      return {
        content: "ok",
        toolCalls: [],
        usage: {
          totalTokens: 400
        }
      };
    }
  };

const { result } = await collectAgentLoop(runAgentLoop({
  input: "hello",
  registry,
  cwd: process.cwd(),
  adapter,
  stream: false,
  session,
  runtimeCache: {}
}));

assert.equal(result.ok, true);
assert.equal(result.response, "ok");
});
