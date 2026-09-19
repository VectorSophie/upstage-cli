// Tests for 3.3.0 Thread B, Task B.4's evidence-store integration:
// a `sandbox:"docker"` run writes a `docker-log` artifact (image, network,
// exit code, duration, stdout/stderr) via src/runtime/artifacts.mjs
// (Task A.1) when a sessionId is provided, and the tool result carries a
// reference to it — never the raw log inlined into the result itself.
//
// Gated on real Docker availability (this dev box has none — see m38's
// gating comment) — same convention as every other live-container
// assertion in this suite.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { DockerExecutor } from "../src/sandbox/docker-executor.mjs";
import { runSandboxedProcess } from "../src/sandbox/exec.mjs";
import { readArtifact } from "../src/runtime/artifacts.mjs";
import { resetSession } from "../src/runtime/session.mjs";

const SKIP_DOCKER = !DockerExecutor.isAvailable();

test("sandbox:'docker' run with a sessionId writes a docker-log artifact, not inline bytes", async () => {
  if (SKIP_DOCKER) return;
  const sessionId = crypto.randomUUID();
  try {
    const result = await runSandboxedProcess("echo", ["hello"], {
      sandbox: "docker",
      cwd: process.cwd(),
      sessionId
    });

    assert.equal(result.ok, true);
    assert.ok(result.artifact, "expected a docker-log artifact reference on the result");
    assert.equal(result.artifact.kind, "docker-log");
    assert.equal(typeof result.artifact.path, "string");

    const bytes = await readArtifact(result.artifact.path);
    const logged = JSON.parse(bytes.toString("utf8"));
    assert.ok(logged.stdout.includes("hello"));
    assert.equal(typeof logged.durationMs, "number");
    assert.equal(typeof logged.image, "string");
  } finally {
    await resetSession(sessionId);
  }
});

test("sandbox:'docker' run without a sessionId still works, just skips the artifact", async () => {
  if (SKIP_DOCKER) return;
  const result = await runSandboxedProcess("echo", ["hello"], { sandbox: "docker", cwd: process.cwd() });
  assert.equal(result.ok, true);
  assert.equal(result.artifact, undefined);
});
