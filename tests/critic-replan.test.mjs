import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Test the model router
import { estimateTaskComplexity, ModelRouter } from "../src/model/router.mjs";

describe("ModelRouter — complexity estimation", () => {
  function msgs(text) {
    return [{ role: "user", content: text }];
  }

  test("write keywords → complex", () => {
    assert.equal(estimateTaskComplexity(msgs("fix the failing test in utils.js")), "complex");
    assert.equal(estimateTaskComplexity(msgs("implement a caching layer")), "complex");
    assert.equal(estimateTaskComplexity(msgs("refactor the auth module")), "complex");
  });

  test("read/explain keywords → simple", () => {
    assert.equal(estimateTaskComplexity(msgs("what is the purpose of this file?")), "simple");
    assert.equal(estimateTaskComplexity(msgs("show me the list of exports")), "simple");
    assert.equal(estimateTaskComplexity(msgs("explain how the loop works")), "simple");
  });

  test("long prompts → complex regardless of keywords", () => {
    const longPrompt = "describe ".repeat(40); // > 300 chars
    assert.equal(estimateTaskComplexity(msgs(longPrompt)), "complex");
  });

  test("empty messages → complex (safe default)", () => {
    assert.equal(estimateTaskComplexity([]), "complex");
    assert.equal(estimateTaskComplexity([{ role: "assistant", content: "hi" }]), "complex");
  });

  test("no user message → complex", () => {
    assert.equal(estimateTaskComplexity([{ role: "system", content: "you are..." }]), "complex");
  });
});

describe("ModelRouter — adapter selection", () => {
  function makeAdapter(name) {
    const calls = [];
    return {
      calls,
      model: name,
      isConfigured: () => true,
      async complete(opts) {
        calls.push({ model: name, opts });
        return { content: `response from ${name}`, toolCalls: [], usage: null };
      }
    };
  }

  test("routes simple prompt to fast adapter", async () => {
    const pro = makeAdapter("solar-pro2");
    const fast = makeAdapter("solar-mini");
    const router = new ModelRouter({ proAdapter: pro, fastAdapter: fast });
    await router.complete({ messages: [{ role: "user", content: "explain what this does" }] });
    assert.equal(fast.calls.length, 1);
    assert.equal(pro.calls.length, 0);
  });

  test("routes complex prompt to pro adapter", async () => {
    const pro = makeAdapter("solar-pro2");
    const fast = makeAdapter("solar-mini");
    const router = new ModelRouter({ proAdapter: pro, fastAdapter: fast });
    await router.complete({ messages: [{ role: "user", content: "fix the bug in auth.js" }] });
    assert.equal(pro.calls.length, 1);
    assert.equal(fast.calls.length, 0);
  });

  test("falls back to pro when no fast adapter", async () => {
    const pro = makeAdapter("solar-pro2");
    const router = new ModelRouter({ proAdapter: pro });
    await router.complete({ messages: [{ role: "user", content: "list all files" }] });
    assert.equal(pro.calls.length, 1);
  });

  test("isConfigured delegates to pro adapter", () => {
    const pro = { isConfigured: () => true, model: "solar-pro2" };
    const router = new ModelRouter({ proAdapter: pro });
    assert.equal(router.isConfigured(), true);
  });

  test("model getter returns pro model name", () => {
    const pro = { isConfigured: () => true, model: "solar-pro2" };
    const router = new ModelRouter({ proAdapter: pro });
    assert.equal(router.model, "solar-pro2");
  });
});

// Test re-plan state helpers (imported via dynamic import to access unexported helpers)
describe("re-plan and critic constants", () => {
  test("loop.mjs has CRITIC and REPLAN in events", async () => {
    const { AgentEventType } = await import("../src/protocol/events.mjs");
    assert.ok("CRITIC" in AgentEventType, "CRITIC event type should exist");
    assert.ok("REPLAN" in AgentEventType, "REPLAN event type should exist");
    assert.equal(AgentEventType.CRITIC, "critic");
    assert.equal(AgentEventType.REPLAN, "replan");
  });
});
