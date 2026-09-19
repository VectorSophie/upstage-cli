// Tests for src/sandbox/docker-executor.mjs (3.3.0 Thread B, Task B.2) — the
// main agent's Docker-backed executor, conforming to the same
// {ok, code, stdout, stderr, truncated, timedOut} shape as
// src/sandbox/exec.mjs's runSandboxedProcess() (the local executor), so
// call sites (Task B.4) can treat "local" and "docker" interchangeably.
//
// Live-container assertions are gated behind Docker availability, same
// pattern as harness/tests/h6-sandbox-docker.test.mjs (SKIP_DOCKER=1 or no
// docker daemon reachable → those tests no-op rather than fail CI).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DockerExecutor } from "../src/sandbox/docker-executor.mjs";

const SKIP_DOCKER = process.env.SKIP_DOCKER === "1" || !DockerExecutor.isAvailable();

test("isAvailable() returns a boolean", () => {
  assert.equal(typeof DockerExecutor.isAvailable(), "boolean");
});

test("exec() runs a command in a container and returns the shared result shape", async () => {
  if (SKIP_DOCKER) return;
  const tmp = mkdtempSync(join(tmpdir(), "m37-docker-"));
  try {
    const executor = new DockerExecutor({ image: "alpine" });
    const result = await executor.exec("echo", ["hello-from-docker"], { cwd: tmp });
    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("hello-from-docker"));
    assert.equal(result.truncated, false);
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("exec() reports non-zero exit codes as ok:false", async () => {
  if (SKIP_DOCKER) return;
  const tmp = mkdtempSync(join(tmpdir(), "m37-docker-exit-"));
  try {
    const executor = new DockerExecutor({ image: "alpine" });
    const result = await executor.exec("sh", ["-c", "exit 7"], { cwd: tmp });
    assert.equal(result.ok, false);
    assert.equal(result.code, 7);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
