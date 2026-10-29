// contextBudget.countTokens: the pre-request fit check uses the server's exact
// count (LocalOpenAIAdapter.countTokens → vLLM /tokenize) instead of an
// estimate. Fake adapters/servers only; private HOME.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { runAgentLoop, collectAgentLoop } from "../src/agent/loop.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { createSession } from "../src/runtime/session.mjs";
import { LocalOpenAIAdapter } from "../src/model/local-openai-adapter.mjs";
import { validateContextBudget, ContextBudgetError } from "../src/agent/effective-context.mjs";

async function withHome(fn) {
  const home = await mkdtemp(join(os.tmpdir(), "m51-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = saved;
    await rm(home, { recursive: true, force: true });
  }
}

const registry = () => new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
function adapter() {
  const requests = [];
  return { requests, model: "Kanana-2", isConfigured: () => true, async complete({ messages }) { requests.push(messages); return { content: "done", toolCalls: [] }; } };
}
const run = (a, contextBudget, input) =>
  collectAgentLoop(runAgentLoop({ input, registry: registry(), cwd: process.cwd(), adapter: a, stream: false, session: createSession(process.cwd()), runtimeCache: {}, contextBudget }));

test("countTokens must be a function", () => {
  assert.throws(() => validateContextBudget({ contextLimit: 8192, maxOutputTokens: 4096, countTokens: 5 }), ContextBudgetError);
});

test("an exact count lets through a request the pessimistic estimate would refuse", async () => {
  await withHome(async () => {
    const task = "TASK " + "y".repeat(6000);
    const pessimistic = { contextLimit: 8192, maxOutputTokens: 4096, charsPerToken: 1.0 };
    const a1 = adapter();
    const r1 = await run(a1, pessimistic, task);
    assert.equal(r1.result.stopReason, "context_exhausted");
    assert.equal(a1.requests.length, 0);
    let calls = 0;
    const a2 = adapter();
    const r2 = await run(a2, { ...pessimistic, countTokens: async () => { calls += 1; return 1800; } }, task);
    assert.equal(r2.result.stopReason, "done");
    assert.equal(a2.requests.length, 1);
    assert.ok(calls >= 1);
    const fit = r2.events.find((e) => e.code === "CONTEXT_FIT");
    assert.equal(fit.exact, 1800);
  });
});

test("an exact count over budget: staged compaction with re-counting, then context_exhausted", async () => {
  await withHome(async () => {
    let calls = 0;
    const a = adapter();
    const r = await run(a, { contextLimit: 8192, maxOutputTokens: 4096, countTokens: async () => { calls += 1; return 9000; } }, "small task");
    assert.equal(r.result.stopReason, "context_exhausted");
    assert.match(r.result.response, /counted at 9000 tokens by the server/);
    assert.equal(a.requests.length, 0);
    assert.equal(calls, 4, "initial count + 3 compaction stages");
  });
});

test("a failing counter falls back to estimates", async () => {
  await withHome(async () => {
    const a = adapter();
    const r = await run(a, { contextLimit: 16384, maxOutputTokens: 8192, countTokens: async () => null }, "small task");
    assert.equal(r.result.stopReason, "done");
    assert.equal(r.events.find((e) => e.code === "CONTEXT_FIT").exact, null);
  });
});

test("LocalOpenAIAdapter.countTokens posts the completion payload to /tokenize", async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(b || "{}") });
      if (req.url === "/tokenize") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ count: 1234, max_model_len: 8192 })); }
      else { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port;
    const ad = new LocalOpenAIAdapter({ model: "EXAONE-4.5", baseUrl: `http://127.0.0.1:${port}/v1`, chatTemplateKwargs: { enable_thinking: true } });
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
    assert.equal(await ad.countTokens([{ role: "user", content: "hi" }], tools), 1234);
    const { url, body } = seen[0];
    assert.equal(url, "/tokenize");
    assert.equal(body.model, "EXAONE-4.5");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.deepEqual(body.tools, tools);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.add_generation_prompt, true);
    const bad = new LocalOpenAIAdapter({ model: "m", baseUrl: `http://127.0.0.1:${port}/nope/v1` });
    assert.equal(await bad.countTokens([{ role: "user", content: "hi" }]), null);
  } finally {
    srv.close();
  }
});
