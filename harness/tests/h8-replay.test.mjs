import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { ReplayEngine } from "../src/replay/engine.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../fixtures/flaky-test");

// Minimal run artifact for tests
function makeRun(overrides = {}) {
  return {
    id: "run_test_001",
    taskId: "fix-flaky-test",
    agentId: "mock",
    status: "pass",
    metrics: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.01
    },
    trace: {
      turns: [
        {
          index: 0,
          thoughtSummary: "Inspecting the failing test",
          toolCalls: [{ tool: "read_file", args: { path: "test.mjs" } }],
          response: "I see the issue — missing await."
        },
        {
          index: 1,
          thoughtSummary: "Applying the fix",
          toolCalls: [{ tool: "write_file", args: { path: "test.mjs", content: "..." } }],
          response: "Fixed the await."
        }
      ],
      toolCalls: [
        { tool: "read_file",  args: { path: "test.mjs" }, ok: true,  result: { content: "..." } },
        { tool: "write_file", args: { path: "test.mjs" }, ok: true,  result: { ok: true } }
      ],
      compactions: [],
      contextStrategyUsed: "default"
    },
    evaluation: { score: 0.91, failToPassRate: 1.0, passToPassRate: 1.0, checks: {} },
    ...overrides
  };
}

// Minimal task for replay tests
function makeTask(repoPath) {
  return {
    id: "fix-flaky-test",
    version: 1,
    description: "Fix the flaky test",
    repo: repoPath,
    prompt: "Fix the flaky async test.",
    context: { strategy: "default", maxFiles: 5, includeTests: true },
    sandbox: { type: "native", timeout: 60 },
    agent: { permissions: "acceptEdits", maxTurns: 4, maxTokens: 8192, tools: { allow: [], deny: [] } },
    checks: {
      fail_to_pass: [{ id: "test-fetch", command: "node --test tests/fetcher.test.mjs", timeout: 20, weight: 0.6 }],
      pass_to_pass: [{ id: "test-config", command: "node --test tests/config.test.mjs", timeout: 20, weight: 0.3 }],
      custom: []
    },
    scoring: { weights: { checks: 0.60, patchMinimality: 0.15, toolCallCount: 0.10, costUsd: 0.10, speedMs: 0.05 } }
  };
}

describe("ReplayEngine", () => {
  let tmpDir;
  let task;
  let runner;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "h8-"));
    task = makeTask(FIXTURE_DIR);
    runner = new TaskRunner({ runsDir: join(tmpDir, "runs") });
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("creates a stub agent from run artifact", () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    assert.ok(stub);
    assert.ok(stub.id.includes("replay:"));
    assert.ok(stub.displayName.includes("Replay"));
    assert.equal(stub.isAvailable(), true);
  });

  it("stub agent id incorporates source run id", () => {
    const run = makeRun({ id: "run_abc_123" });
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    assert.equal(stub.id, "replay:run_abc_123");
  });

  it("stub agent run() returns ok:true", async () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    const result = await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(result.ok, true);
  });

  it("stub agent replays correct turn count", async () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    const result = await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(result.turns, 2);
  });

  it("stub agent replays correct tool call count", async () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    const result = await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(result.toolCalls, 2);
  });

  it("setStopAtTurn limits replayed turns", async () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    engine.setStopAtTurn(1);
    const stub = engine.createStubAgent();
    const result = await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(result.turns, 1);
    assert.ok(result.stopReason.includes("stopped_at_turn"));
  });

  it("no divergences when tools match recorded", async () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(engine.divergences.length, 0);
  });

  it("detects divergence when recorded and replayed tools differ", () => {
    const run = makeRun({
      trace: {
        turns: [
          { index: 0, toolCalls: [{ tool: "write_file", args: {} }], response: "done" }
        ],
        // recorded says read_file but turn says write_file
        toolCalls: [{ tool: "read_file", args: {}, ok: true, result: {} }],
        compactions: [],
        contextStrategyUsed: "default"
      }
    });
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    // run synchronously — divergence is detected during replay
    return stub.run(task, { workdir: tmpDir, auditLog: null }).then(() => {
      const divs = engine.divergences;
      assert.equal(divs.length, 1);
      assert.equal(divs[0].expected, "read_file");
      assert.equal(divs[0].actual, "write_file");
      assert.equal(divs[0].turn, 0);
    });
  });

  it("engine.divergences is a copy (mutation-safe)", () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const d1 = engine.divergences;
    d1.push({ fake: true });
    assert.equal(engine.divergences.length, 0);
  });

  it("stopReason is replay_complete when no stop turn set", async () => {
    const run = makeRun();
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    const result = await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(result.stopReason, "replay_complete");
  });

  it("empty run trace replays zero turns", async () => {
    const run = makeRun({
      trace: { turns: [], toolCalls: [], compactions: [], contextStrategyUsed: "default" }
    });
    const engine = new ReplayEngine(run);
    const stub = engine.createStubAgent();
    const result = await stub.run(task, { workdir: tmpDir, auditLog: null });
    assert.equal(result.turns, 0);
    assert.equal(result.toolCalls, 0);
  });
});
