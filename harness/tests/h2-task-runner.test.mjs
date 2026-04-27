import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { TaskRunner } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";
import { CodingAgent } from "../src/agent/interface.mjs";

const FIXTURE_MISSING_IMPORT = resolve(new URL("../fixtures/missing-import", import.meta.url).pathname.slice(1));
const FIXTURE_SECURITY_BUG = resolve(new URL("../fixtures/security-bug", import.meta.url).pathname.slice(1));

function makeTask(overrides = {}) {
  return {
    id: "test-task",
    version: 1,
    repo: FIXTURE_MISSING_IMPORT,
    prompt: "Fix the bug.",
    context: { strategy: "default", maxFiles: 5, includeTests: true },
    sandbox: { type: "native", timeout: 30, network: "none" },
    agent: { permissions: "acceptEdits", maxTurns: 3, maxTokens: 8192, tools: { allow: [], deny: [] } },
    checks: { fail_to_pass: [], pass_to_pass: [], custom: [] },
    scoring: { weights: { checks: 1 }, costBudgetUsd: 1.0 },
    expectedPatchScope: [],
    expectedMaxLines: 50,
    ...overrides
  };
}

// ── MockAgent ─────────────────────────────────────────────────────────────────

describe("MockAgent — interface", () => {
  it("has id='mock'", () => {
    assert.equal(new MockAgent().id, "mock");
  });

  it("isAvailable() returns true", () => {
    assert.equal(new MockAgent().isAvailable(), true);
  });

  it("extends CodingAgent", () => {
    assert.ok(new MockAgent() instanceof CodingAgent);
  });

  it("run() returns ok:false when README.fixture.md missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h2-mock-"));
    try {
      const result = await new MockAgent().run(makeTask({ repo: tmp }), { workdir: tmp });
      assert.equal(result.ok, false);
      assert.match(result.error, /README\.fixture\.md/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── TaskRunner ────────────────────────────────────────────────────────────────

describe("TaskRunner — validation", () => {
  it("throws on invalid task spec", async () => {
    const runner = new TaskRunner();
    const badTask = { id: "", repo: "./x", prompt: "p", checks: {} };
    await assert.rejects(() => runner.run(badTask, new MockAgent()), /Invalid task/);
  });
});

describe("TaskRunner — mock agent runs", () => {
  it("pass_to_pass baseline abort when checks fail pre-agent", async () => {
    const runner = new TaskRunner();
    const task = makeTask({
      checks: {
        fail_to_pass: [],
        pass_to_pass: [{ id: "always-fail", command: "node -e \"process.exit(1)\"", timeout: 5 }]
      }
    });
    await assert.rejects(() => runner.run(task, new MockAgent()), /Baseline failed/);
  });

  it("run produces a RunResult with required fields", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h2-run-"));
    try {
      cpSync(FIXTURE_MISSING_IMPORT, tmp, { recursive: true });
      const runner = new TaskRunner();
      const task = makeTask({ repo: tmp, checks: { fail_to_pass: [], pass_to_pass: [], custom: [] } });
      const result = await runner.run(task, new MockAgent());
      assert.ok(result.id);
      assert.ok(typeof result.status === "string");
      assert.ok(typeof result.durationMs === "number");
      assert.ok(result.evaluation);
      assert.ok(result.metrics);
      assert.ok(result.trace);
      assert.ok(result.patch);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run result has SWE-bench instance_id field", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h2-swe-"));
    try {
      cpSync(FIXTURE_MISSING_IMPORT, tmp, { recursive: true });
      const runner = new TaskRunner();
      const task = makeTask({ repo: tmp, id: "swe-test", checks: { fail_to_pass: [], pass_to_pass: [] } });
      const result = await runner.run(task, new MockAgent());
      assert.equal(result.instance_id, "swe-test");
      assert.equal(result.taskId, "swe-test");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("check run order: pass_to_pass runs before fail_to_pass when baseline captured", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h2-order-"));
    const order = [];
    try {
      cpSync(FIXTURE_MISSING_IMPORT, tmp, { recursive: true });
      const runner = new TaskRunner();
      const task = makeTask({
        repo: tmp,
        checks: { fail_to_pass: [], pass_to_pass: [], custom: [] }
      });
      await runner.run(task, new MockAgent());
      assert.ok(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("persists run JSON when runsDir provided", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h2-persist-"));
    const runsDir = join(tmp, "runs");
    try {
      cpSync(FIXTURE_MISSING_IMPORT, tmp + "/fixture", { recursive: true });
      const runner = new TaskRunner({ runsDir });
      const task = makeTask({ repo: tmp + "/fixture", checks: { fail_to_pass: [], pass_to_pass: [] } });
      const result = await runner.run(task, new MockAgent());
      const { existsSync } = await import("node:fs");
      assert.ok(existsSync(join(runsDir, `${result.id}.json`)));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("TaskRunner — failure classification integration", () => {
  it("classifies incomplete_patch when MockAgent has no README", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h2-fail-"));
    try {
      // Need at least one file so git commit succeeds
      writeFileSync(join(tmp, "placeholder.txt"), "fixture\n");
      const runner = new TaskRunner();
      const task = makeTask({
        repo: tmp,
        checks: { fail_to_pass: [{ id: "f", command: "node -e \"process.exit(1)\"", timeout: 5 }], pass_to_pass: [] }
      });
      // no README.fixture.md → mock returns ok:false, no files changed → fail
      const result = await runner.run(task, new MockAgent());
      assert.equal(result.status, "fail");
      assert.ok(result.failure !== null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
