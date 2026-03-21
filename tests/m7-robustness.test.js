import test from "node:test";
import assert from "node:assert/strict";

import { UpstageAdapter } from "../src/model/upstage-adapter.js";
import { runAgentLoop } from "../src/agent/loop.js";
import { createSession } from "../src/runtime/session.js";
import { ToolRegistry } from "../src/tools/registry.js";

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
  const runOnce = (input) =>
    runAgentLoop({
      input,
      registry,
      cwd: process.cwd(),
      adapter,
      stream: false,
      session,
      runtimeCache: {},
      onEvent: (event) => events.push(event)
    });

  const first = await runOnce("first turn");
  const second = await runOnce("second turn");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const tokenEvents = events.filter((event) => event.type === "TOKEN_USAGE");
  const warningEvents = events.filter((event) => event.type === "SYSTEM_WARNING");

  assert.equal(tokenEvents.length, 2);
  assert.equal(warningEvents.length, 1);
  assert.equal(warningEvents[0].code, "TOKEN_CONTEXT_HIGH");
  assert.ok(warningEvents[0].usage.totalTokens > 800000);

  const runtimeWarning = session.runtimeEvents.find((event) => event.type === "SYSTEM_WARNING");
  assert.ok(runtimeWarning);
});
