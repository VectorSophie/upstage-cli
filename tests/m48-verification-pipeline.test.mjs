// Tests for src/tools/builtin/run-verification.mjs's evidence bundling
// (3.3.0 Thread E, Task E.1) — "see it, run it, prove it": run_verification
// is where the final bundle is assembled, not a second orchestrator. The
// agent loop still calls run_linter/run_typecheck/run_tests (this tool's
// existing job) AND, separately, browser_open/console/screenshot and
// inspect_image (Threads C/D) — this tool folds whatever evidence resulted
// from both into one structured result.
//
// Every stage/evidence source is independently optional and never causes a
// failure by its absence — matches the project's "graceful degradation"
// taste constraint, verified explicitly below.

import test from "node:test";
import assert from "node:assert/strict";

import { runVerificationTool, collectEvidence } from "../src/tools/builtin/run-verification.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";

// ── collectEvidence (pure helper) ──────────────────────────────────────────

test("collectEvidence returns an empty object when there's nothing to report", () => {
  assert.deepEqual(collectEvidence([], undefined), {});
});

test("collectEvidence pulls docker-log artifacts out of stage results automatically", () => {
  const results = [
    { stage: "run_linter", ok: true, data: { artifact: { kind: "docker-log", path: "/a", hash: "h1", bytes: 10 } } },
    { stage: "run_tests", ok: true, data: { artifact: { kind: "docker-log", path: "/b", hash: "h2", bytes: 20 } } },
    { stage: "run_typecheck", ok: true, data: {} } // no docker artifact — local run, skipped silently
  ];
  const evidence = collectEvidence(results, undefined);
  assert.equal(evidence.dockerLogs.length, 2);
  assert.equal(evidence.dockerLogs[0].hash, "h1");
});

test("collectEvidence merges caller-supplied browser/vision evidence alongside auto-collected docker logs", () => {
  const results = [{ stage: "run_tests", ok: true, data: {} }];
  const callerEvidence = {
    browserConsole: { kind: "console-log", path: "/c", hash: "h3", bytes: 5 },
    screenshot: { kind: "screenshot", path: "/s", hash: "h4", bytes: 999 },
    visionResponse: { kind: "vision-response", path: "/v", hash: "h5", bytes: 12 }
  };
  const evidence = collectEvidence(results, callerEvidence);
  assert.equal(evidence.dockerLogs, undefined, "no docker artifacts were present in results");
  assert.deepEqual(evidence.browserConsole, callerEvidence.browserConsole);
  assert.deepEqual(evidence.screenshot, callerEvidence.screenshot);
  assert.deepEqual(evidence.visionResponse, callerEvidence.visionResponse);
});

test("collectEvidence ignores non-object callerEvidence rather than throwing", () => {
  assert.deepEqual(collectEvidence([], "not-an-object"), {});
  assert.deepEqual(collectEvidence([], null), {});
});

// ── run_verification.execute — full tool-level behavior ────────────────────

test("run_verification always returns an evidence field, even with nothing to report (no Docker, no browser, no vision)", async () => {
  const registry = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  registry.register({
    name: "run_linter", risk: "low", inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async execute() { return { ok: true }; }
  });
  registry.register(runVerificationTool);

  const outcome = await registry.execute("run_verification", { stages: ["run_linter"] }, { cwd: process.cwd() });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.data.evidence, {}, "graceful degradation: nothing configured, empty evidence, no failure");
});

test("run_verification folds caller-supplied evidence into its final result", async () => {
  const registry = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  registry.register({
    name: "run_linter", risk: "low", inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async execute() { return { ok: true }; }
  });
  registry.register(runVerificationTool);

  const evidence = { screenshot: { kind: "screenshot", path: "/s", hash: "abc", bytes: 42 } };
  const outcome = await registry.execute(
    "run_verification",
    { stages: ["run_linter"], evidence },
    { cwd: process.cwd() }
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.data.evidence.screenshot, evidence.screenshot);
});

test("run_verification still reports ok:false on a real stage failure, evidence or not", async () => {
  const registry = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  registry.register({
    name: "run_linter", risk: "low", inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async execute() { return { ok: false, error: { message: "lint failed", code: "LINT_FAILED" } }; }
  });
  registry.register(runVerificationTool);

  const outcome = await registry.execute("run_verification", { stages: ["run_linter"] }, { cwd: process.cwd() });
  assert.equal(outcome.data.ok, false);
  assert.deepEqual(outcome.data.evidence, {});
});
