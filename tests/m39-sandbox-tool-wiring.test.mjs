// Tests for 3.3.0 Thread B, Task B.4 — run_shell/run_tests/run_linter/
// run_typecheck/run_verification all accept a `sandbox` arg and forward it
// to src/sandbox/exec.mjs, so `--sandbox docker` reaches every verification
// call site, not just an obvious one or two.
//
// Docker is confirmed unavailable on this machine (see m38's gating
// comment), so passing sandbox:"docker" end-to-end through each tool
// deterministically hits the fail-closed DOCKER_UNAVAILABLE path — which
// is exactly what proves the arg was actually forwarded into exec.mjs
// rather than silently dropped.

import test from "node:test";
import assert from "node:assert/strict";

import { DockerExecutor } from "../src/sandbox/docker-executor.mjs";
import { runShellTool } from "../src/tools/builtin/run-shell.mjs";
import { runTestsTool } from "../src/tools/builtin/run-tests.mjs";
import { runLinterTool } from "../src/tools/builtin/run-linter.mjs";
import { runTypecheckTool } from "../src/tools/builtin/run-typecheck.mjs";
import { runVerificationTool } from "../src/tools/builtin/run-verification.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";

const SKIP_DOCKER = DockerExecutor.isAvailable();

test("run_shell forwards args.sandbox to the executor", async () => {
  if (SKIP_DOCKER) return;
  await assert.rejects(
    () => runShellTool.execute({ command: "echo hi", sandbox: "docker" }, { cwd: process.cwd() }),
    (err) => err.code === "DOCKER_UNAVAILABLE"
  );
});

test("run_tests forwards args.sandbox to the executor", async () => {
  if (SKIP_DOCKER) return;
  await assert.rejects(
    () => runTestsTool.execute({ command: ["echo", "hi"], sandbox: "docker" }, { cwd: process.cwd() }),
    (err) => err.code === "DOCKER_UNAVAILABLE"
  );
});

test("run_linter forwards args.sandbox to the executor", async () => {
  if (SKIP_DOCKER) return;
  await assert.rejects(
    () => runLinterTool.execute({ command: ["echo", "hi"], sandbox: "docker" }, { cwd: process.cwd() }),
    (err) => err.code === "DOCKER_UNAVAILABLE"
  );
});

test("run_typecheck forwards args.sandbox to the executor", async () => {
  if (SKIP_DOCKER) return;
  await assert.rejects(
    () => runTypecheckTool.execute({ command: ["echo", "hi"], sandbox: "docker" }, { cwd: process.cwd() }),
    (err) => err.code === "DOCKER_UNAVAILABLE"
  );
});

test("run_verification forwards args.sandbox into each delegated stage", async () => {
  if (SKIP_DOCKER) return;
  const registry = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  registry.register(runLinterTool);
  registry.register(runTypecheckTool);
  registry.register(runTestsTool);
  registry.register(runVerificationTool);

  const outcome = await registry.execute(
    "run_verification",
    { sandbox: "docker", stages: ["run_linter"] },
    { cwd: process.cwd() }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.data.ok, false);
  assert.equal(outcome.data.results[0].error?.code, "DOCKER_UNAVAILABLE");
});

test("sandbox omitted (default local) still works end-to-end", async () => {
  const result = await runShellTool.execute({ command: "echo hi" }, { cwd: process.cwd() });
  assert.equal(result.ok, true);
});
