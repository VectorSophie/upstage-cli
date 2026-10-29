// Caller-validated context budget (src/agent/effective-context.mjs + its use
// in src/agent/loop.mjs). Fake adapters only; HOME is private so session
// files never touch the real ~/.upstage-cli.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { runAgentLoop, collectAgentLoop } from "../src/agent/loop.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { createSession } from "../src/runtime/session.mjs";
import { resolveEffectiveContext, validateContextBudget, ContextBudgetError, estimateWith } from "../src/agent/effective-context.mjs";
import { formatContextForModel } from "../src/agent/context-builder.mjs";
import { ContextManager } from "../src/core/context-manager.mjs";
import { getModelCapabilities } from "../src/model/model-capabilities.mjs";

const UNKNOWN_LOCAL_ID = "Kanana-2"; // not in the capability table → 65,536 fallback
const B8K = { contextLimit: 8192, maxOutputTokens: 4096, charsPerToken: 1.7, source: "test" };
const B16K = { contextLimit: 16384, maxOutputTokens: 8192, charsPerToken: 1.9, source: "test" };

async function withHome(fn) {
  const home = await mkdtemp(join(os.tmpdir(), "m40-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  }
}

function registryWithEcho() {
  const registry = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  registry.register({
    name: "echo", description: "echo tool", risk: "low", actionClass: "read",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
    async execute(args) { return { text: args.text || "" }; }
  });
  return registry;
}

function recordingAdapter(respond, extra = {}) {
  const requests = [];
  return {
    model: UNKNOWN_LOCAL_ID,
    requests,
    isConfigured: () => true,
    async complete({ messages }) {
      requests.push(messages);
      return respond(messages, requests.length);
    },
    ...extra
  };
}

const done = () => ({ content: "done", toolCalls: [] });
const run = (opts) => collectAgentLoop(runAgentLoop({ cwd: process.cwd(), stream: false, runtimeCache: {}, ...opts }));

test("1. 8K and 16K caller limits replace the 65,536 fallback; without a budget the fallback is unchanged", () => {
  assert.equal(getModelCapabilities(UNKNOWN_LOCAL_ID).contextLimit, 65536);
  assert.equal(resolveEffectiveContext({ modelId: UNKNOWN_LOCAL_ID, env: {} }).contextLimit, 65536);
  const e8 = resolveEffectiveContext({ contextBudget: B8K, modelId: UNKNOWN_LOCAL_ID, env: {} });
  const e16 = resolveEffectiveContext({ contextBudget: B16K, modelId: UNKNOWN_LOCAL_ID, env: {} });
  assert.equal(e8.contextLimit, 8192);
  assert.equal(e16.contextLimit, 16384);
  // the caller budget also beats the env override
  assert.equal(resolveEffectiveContext({ contextBudget: B8K, modelId: UNKNOWN_LOCAL_ID, env: { UPSTAGE_MODEL_CONTEXT_LIMIT: "65536" } }).contextLimit, 8192);
});

test("3. output reservation and margin come out of the input budget", () => {
  const e = validateContextBudget(B8K);
  assert.equal(e.safetyMarginTokens, Math.ceil(8192 * 0.05));
  assert.equal(e.inputBudget, 8192 - 4096 - e.safetyMarginTokens);
});

test("5. genuine product models keep their capability-table behaviour", () => {
  for (const id of ["solar-pro4", "solar-pro3", "solar-pro2"]) {
    const e = resolveEffectiveContext({ modelId: id, env: {} });
    assert.equal(e.explicit, false);
    assert.equal(e.contextLimit, getModelCapabilities(id).contextLimit);
    assert.equal(e.repoContextMaxChars, null);
  }
  // default context-block cap is still derived from the model id
  const big = { repoSummary: { totalFiles: 1, map: "x".repeat(50000) }, keywords: [], snippets: [], modules: [] };
  const capped = formatContextForModel(big, { modelId: "solar-pro4" });
  const expected = Math.floor(getModelCapabilities("solar-pro4").contextLimit * 4 * 0.09);
  assert.ok(capped.length <= expected + 40);
});

test("6. invalid or contradictory budgets are rejected", async () => {
  const bad = [
    { contextLimit: 8192, maxOutputTokens: 8192 },
    { contextLimit: 8192, maxOutputTokens: 9000 },
    { contextLimit: 8192.5, maxOutputTokens: 1000 },
    { contextLimit: 8192, maxOutputTokens: 0 },
    { contextLimit: 8192, maxOutputTokens: 1000, charsPerToken: 0 },
    { contextLimit: 8192, maxOutputTokens: 1000, safetyMarginRatio: 0.6 },
    { contextLimit: 1024, maxOutputTokens: 900 },
    "8192"
  ];
  for (const b of bad) assert.throws(() => validateContextBudget(b), ContextBudgetError, JSON.stringify(b));
  // adapter max_tokens larger than the declared reservation
  await withHome(async () => {
    const adapter = recordingAdapter(done, { maxTokens: 6000 });
    await assert.rejects(
      run({ input: "hi", registry: registryWithEcho(), adapter, session: createSession(process.cwd()), contextBudget: B8K }),
      ContextBudgetError
    );
    assert.equal(adapter.requests.length, 0, "no request was sent");
  });
});

test("2+3. every request under an explicit budget fits it, with the repository context capped", async () => {
  await withHome(async () => {
    const adapter = recordingAdapter(done, { maxTokens: 4096 });
    const { result } = await run({ input: "Fix the bug in parser.mjs", registry: registryWithEcho(), adapter, session: createSession(process.cwd()), contextBudget: B8K });
    assert.equal(result.stopReason, "done");
    const e = validateContextBudget(B8K);
    const contextBlock = adapter.requests[0][1].content;
    assert.ok(contextBlock.length <= e.repoContextMaxChars + 40, `context block ${contextBlock.length} > cap ${e.repoContextMaxChars}`);
    const est = adapter.requests[0].reduce((n, m) => n + estimateWith(e, m.content || ""), 0);
    assert.ok(est <= e.inputBudget, `request ${est} > input budget ${e.inputBudget}`);
  });
});

test("4+9. resumed conversation: compaction uses the explicit ceiling and keeps the task verbatim", async () => {
  await withHome(async () => {
    const session = createSession(process.cwd());
    // ~60k chars of earlier history: far above an 8K window, far below 80% of 64K at 4 chars/token
    for (let i = 0; i < 30; i++) {
      session.history.push({ role: "user", content: `old question ${i} ` + "q".repeat(1000) });
      session.history.push({ role: "assistant", content: `old answer ${i} ` + "a".repeat(1000) });
    }
    const task = "TASK: rename foo to bar in util.mjs";
    const explicit = recordingAdapter(done);
    const r1 = await run({ input: task, registry: registryWithEcho(), adapter: explicit, session, contextBudget: B8K });
    assert.ok(r1.events.some((ev) => ev.type === "compaction"), "compacted under the 8K budget");
    const sent = explicit.requests[0];
    assert.ok(sent.some((m) => m.role === "user" && m.content === task), "task message kept verbatim");
    const e = validateContextBudget(B8K);
    const est = sent.reduce((n, m) => n + estimateWith(e, m.content || ""), 0);
    assert.ok(est <= e.inputBudget);

    // same history without a budget: 64K fallback, no compaction (old behaviour)
    const session2 = createSession(process.cwd());
    session2.history = session.history.slice(0, 60);
    const fallback = recordingAdapter(done);
    const r2 = await run({ input: task, registry: registryWithEcho(), adapter: fallback, session: session2 });
    assert.ok(!r2.events.some((ev) => ev.type === "compaction"));
  });
});

test("4. ContextManager full compaction keeps a pinned message; default compaction unchanged", () => {
  const cm = new ContextManager(100, 0.8);
  const pinned = { role: "user", content: "the task" };
  const msgs = [pinned, ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(200) }))];
  const out = cm.compact(msgs, 4, { pinned, force: true });
  assert.equal(out[0], pinned);
  assert.equal(out.length, 1 + 1 + 4);
  const legacy = new ContextManager(100, 0.8).compact(msgs, 4);
  assert.notEqual(legacy[0], pinned);
});

test("7+8. context-length rejection: exactly one compaction retry, then context_exhausted — no loop", async () => {
  await withHome(async () => {
    const adapter = recordingAdapter(() => {
      throw new Error("[context_length] (400) This model's maximum context length is 8192 tokens");
    });
    const { result } = await run({ input: "x", registry: registryWithEcho(), adapter, session: createSession(process.cwd()), contextBudget: B8K });
    assert.equal(adapter.requests.length, 2);
    assert.equal(result.stopReason, "context_exhausted");
    assert.equal(result.ok, false);
  });
});

test("fail closed: a task that cannot fit is never sent", async () => {
  await withHome(async () => {
    const adapter = recordingAdapter(done);
    const huge = "word ".repeat(20000);
    const { result } = await run({ input: huge, registry: registryWithEcho(), adapter, session: createSession(process.cwd()), contextBudget: B8K });
    assert.equal(result.stopReason, "context_exhausted");
    assert.equal(adapter.requests.length, 0);
  });
});

test("an oversized tool result is truncated to the budget, with a marker", async () => {
  await withHome(async () => {
    const registry = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
    registry.register({
      name: "dump", description: "big output", risk: "low", actionClass: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { text: "z".repeat(200000) }; }
    });
    const adapter = recordingAdapter((messages, n) =>
      n === 1 ? { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "dump", arguments: "{}" } }] } : done()
    );
    const { result } = await run({ input: "dump it", registry, adapter, session: createSession(process.cwd()), contextBudget: B16K });
    assert.equal(result.stopReason, "done");
    const tool = adapter.requests[1].find((m) => m.role === "tool");
    assert.ok(tool.content.length < 200000);
    assert.match(tool.content, /tool result truncated/);
  });
});

test("4. a long tool episode compacts, and every request still carries the task verbatim", async () => {
  await withHome(async () => {
    const task = "TASK: make parse() accept trailing commas";
    let turn = 0;
    const adapter = recordingAdapter(() => {
      turn += 1;
      if (turn > 12) return done();
      return { content: "", toolCalls: [{ id: `c${turn}`, type: "function", function: { name: "echo", arguments: JSON.stringify({ text: "r".repeat(900) }) } }] };
    });
    const { result, events } = await run({
      input: task, registry: registryWithEcho(), adapter, session: createSession(process.cwd()),
      contextBudget: B8K, budget: { maxSteps: 20, maxWallTimeMs: 60000, maxToolCalls: 50 }
    });
    assert.equal(result.stopReason, "done", result.response);
    assert.ok(events.some((ev) => ev.type === "compaction"), "the episode compacted");
    for (const [i, req] of adapter.requests.entries()) {
      assert.ok(req.some((m) => m.role === "user" && m.content === task), `request ${i + 1} lost the task`);
    }
  });
});

function usageAdapter(reportRatio) {
  // one tool call, then done; optionally reports usage.prompt_tokens =
  // reportRatio x (characters sent / 4)
  let turn = 0;
  return recordingAdapter((messages) => {
    turn += 1;
    const chars = messages.reduce((n, m) => n + (m.content || "").length, 0);
    const usage = reportRatio ? { prompt_tokens: Math.ceil((chars / 4) * reportRatio), completion_tokens: 10 } : undefined;
    if (turn === 1) return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "echo", arguments: JSON.stringify({ text: "r".repeat(3000) }) } }], usage };
    return { content: "done", toolCalls: [], usage };
  });
}

test("observed server usage replaces a pessimistic calibration (episode continues where calibration alone stops)", async () => {
  await withHome(async () => {
    const budget = { contextLimit: 16384, maxOutputTokens: 8192, charsPerToken: 1.0 };
    const task = "TASK " + "x".repeat(1000);
    const calibrated = usageAdapter(null);
    const r1 = await run({ input: task, registry: registryWithEcho(), adapter: calibrated, session: createSession(process.cwd()), contextBudget: budget });
    assert.equal(r1.result.stopReason, "context_exhausted", "calibration alone stops after the tool result");
    assert.equal(calibrated.requests.length, 1);
    const observed = usageAdapter(1.0);
    const r2 = await run({ input: task, registry: registryWithEcho(), adapter: observed, session: createSession(process.cwd()), contextBudget: budget });
    assert.equal(r2.result.stopReason, "done");
    assert.equal(observed.requests.length, 2);
    assert.ok(r2.events.some((e) => e.code === "CONTEXT_CALIBRATION"));
  });
});

test("observed usage above the calibration makes estimates stricter (fails closed earlier)", async () => {
  await withHome(async () => {
    const budget = { contextLimit: 16384, maxOutputTokens: 8192, charsPerToken: 4 };
    const task = "TASK " + "x".repeat(4500);
    const optimistic = usageAdapter(null);
    const r1 = await run({ input: task, registry: registryWithEcho(), adapter: optimistic, session: createSession(process.cwd()), contextBudget: budget });
    assert.equal(r1.result.stopReason, "done");
    const heavy = usageAdapter(3.5); // server counts 3.5x the heuristic
    const r2 = await run({ input: task, registry: registryWithEcho(), adapter: heavy, session: createSession(process.cwd()), contextBudget: budget });
    assert.equal(r2.result.stopReason, "context_exhausted");
    assert.equal(heavy.requests.length, 1, "the second request was not sent");
  });
});
