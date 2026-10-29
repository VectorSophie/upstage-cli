import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentRegistry } from "../src/agent/adapters/upstage.mjs";
import { runAgentLoop, collectAgentLoop } from "../../src/agent/loop.mjs";
import { createSession } from "../../src/runtime/session.mjs";
import { DEFAULT_LOOP_BUDGET } from "../../src/config/defaults.mjs";

// P1-A: the shared agent loop must honor finish_reason. A truncated generation
// (finish_reason=length / content_filter) must NEVER be reported as an ordinary
// DONE completion, and a tool call cut off by truncation must NOT be executed.
// Driven through the REAL loop with a scripted stub adapter (no HTTP).

let savedCritic;
before(() => { savedCritic = process.env.UPSTAGE_CRITIC_DISABLED; process.env.UPSTAGE_CRITIC_DISABLED = "true"; });
after(() => { if (savedCritic === undefined) delete process.env.UPSTAGE_CRITIC_DISABLED; else process.env.UPSTAGE_CRITIC_DISABLED = savedCritic; });

function stubAdapter(script) {
  let i = 0;
  return {
    model: "stub",
    isConfigured: () => true,
    complete: async () => {
      const c = i < script.length ? script[i] : { content: "done", toolCalls: [], reasoning: null, finishReason: "stop", usage: null };
      i += 1;
      return { toolCalls: [], reasoning: null, usage: null, ...c };
    }
  };
}
function writeCall(path, content) {
  return [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path, content }) } }];
}

async function runLoop(script) {
  const workdir = mkdtempSync(join(tmpdir(), "h16-"));
  const { registry } = await buildAgentRegistry({ prompt: "p", agent: {} }, { workdir, executor: { type: "native" } });
  const gen = runAgentLoop({
    input: "do the task",
    registry,
    cwd: workdir,
    adapter: stubAdapter(script),
    stream: false,
    session: createSession(workdir),
    budget: { ...DEFAULT_LOOP_BUDGET, maxSteps: 4, maxWallTimeMs: 30000 },
    settings: {},
    addDirs: []
  });
  const { result, events } = await collectAgentLoop(gen);
  return { result, events, workdir };
}

describe("agent loop — finish_reason handling (P1-A)", () => {
  it("1. complete answer (stop) → ok DONE", async () => {
    const { result } = await runLoop([{ content: "The answer is 42.", finishReason: "stop" }]);
    assert.equal(result.ok, true);
    assert.equal(result.stopReason, "done");
  });

  it("2. valid tool call (tool_calls) then stop → executes the tool, ends DONE", async () => {
    const { result, workdir } = await runLoop([
      { content: "", toolCalls: writeCall("out.txt", "hello"), finishReason: "tool_calls" },
      { content: "Done.", finishReason: "stop" }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.stopReason, "done");
    assert.equal(readFileSync(join(workdir, "out.txt"), "utf8"), "hello");
  });

  it("3. truncated reasoning, no final answer (length) → NOT done, output_truncated", async () => {
    const { result } = await runLoop([{ content: "", reasoning: "thinking and thinking...", finishReason: "length" }]);
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "output_truncated");
  });

  it("4. truncated content without tool calls (length) → output_truncated", async () => {
    const { result } = await runLoop([{ content: "Here is my partial answer that cuts o", finishReason: "length" }]);
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "output_truncated");
  });

  it("5. truncated tool-call output (length) → tool is NOT executed", async () => {
    const { result, workdir } = await runLoop([
      { content: "", toolCalls: writeCall("should-not-exist.txt", "x"), finishReason: "length" }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "output_truncated");
    assert.equal(existsSync(join(workdir, "should-not-exist.txt")), false, "a truncated tool call must not be executed");
  });

  it("6. a partial answer that looks plausible (length) is still truncated, not DONE", async () => {
    const { result } = await runLoop([{ content: "The fix is to add the missing import. Done.", finishReason: "length" }]);
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "output_truncated");
  });

  it("7. content_filter → treated as truncated/incomplete, not DONE", async () => {
    const { result } = await runLoop([{ content: "", finishReason: "content_filter" }]);
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "output_truncated");
  });

  it("8. missing/unknown finish_reason with content → unchanged (DONE)", async () => {
    const { result } = await runLoop([{ content: "answer", finishReason: null }]);
    assert.equal(result.ok, true);
    assert.equal(result.stopReason, "done");
  });
});
