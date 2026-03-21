import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { PolicyEngine } from "../src/core/policy/engine.js";
import { createRegistry } from "../src/tools/create-registry.js";

test("policy engine defaults writes to process.cwd() scope", () => {
  const engine = new PolicyEngine();

  const allowed = engine.evaluateWritePath("src/policy-check.txt", { cwd: process.cwd() });
  assert.equal(allowed.allowed, true);

  const blocked = engine.evaluateWritePath("../policy-check.txt", { cwd: process.cwd() });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.errorCode, "POLICY_VIOLATION");
});

test("write_file returns POLICY_VIOLATION for escaped paths", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "upstage-cli-m8-"));
  const logs = [];

  try {
    const registry = createRegistry({
      allowHighRiskTools: true,
      requireConfirmationForHighRisk: false,
      trustedWritePaths: [cwd]
    });

    const result = await registry.execute(
      "write_file",
      { path: "../blocked-by-policy.txt", content: "blocked" },
      {
        cwd,
        onLog: (payload) => logs.push(payload)
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "POLICY_VIOLATION");
    assert.ok(
      logs.some((entry) => entry?.stage === "policy" && entry?.channel === "security"),
      "blocked write should be logged through context.onLog"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SECURITY_OVERRIDE allows advanced users to bypass path restriction", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "upstage-cli-m8-"));
  const marker = `override-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  const outsidePath = join(cwd, "..", marker);
  const previousOverride = process.env.SECURITY_OVERRIDE;
  process.env.SECURITY_OVERRIDE = "1";

  try {
    const registry = createRegistry({
      allowHighRiskTools: true,
      requireConfirmationForHighRisk: false,
      trustedWritePaths: [cwd]
    });

    const result = await registry.execute(
      "write_file",
      { path: `../${marker}`, content: "override-enabled" },
      { cwd }
    );

    assert.equal(result.ok, true);
    const written = await readFile(outsidePath, "utf8");
    assert.equal(written, "override-enabled");
  } finally {
    if (typeof previousOverride === "string") {
      process.env.SECURITY_OVERRIDE = previousOverride;
    } else {
      delete process.env.SECURITY_OVERRIDE;
    }
    await rm(outsidePath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
