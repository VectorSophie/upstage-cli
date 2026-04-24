import test from "node:test";
import assert from "node:assert/strict";

import { createRegistry } from "../src/tools/create-registry.mjs";
import { createSession } from "../src/runtime/session.mjs";

test("run_subagent executes scoped fallback task and returns structured report", async () => {
  const registry = createRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const result = await registry.execute(
    "run_subagent",
    {
      task: "/tools",
      role: "explorer"
    },
    {
      cwd: process.cwd(),
      adapter: null,
      runtimeCache: {},
      session: createSession(process.cwd())
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.role, "explorer");
  assert.equal(typeof result.data.response, "string");
  assert.ok(Array.isArray(result.data.trace));
});

test("run_subagent enforces allowlist for delegated tool execution", async () => {
  const registry = createRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const result = await registry.execute(
    "run_subagent",
    {
      task: "echo hello",
      role: "explorer",
      allowedTools: ["read_file"],
      maxSteps: 2
    },
    {
      cwd: process.cwd(),
      adapter: null,
      runtimeCache: {},
      session: createSession(process.cwd())
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.stopReason, "policy_blocked");
});
