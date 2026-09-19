// Tests for src/sandbox/select-executor.mjs (3.3.0 Thread B, Task B.3) and
// its wiring into src/sandbox/exec.mjs's runSandboxedProcess/runSandboxedCommand.
//
// Core rule (owner decision, docs/superpowers/specs/2026-09-19-3.3.0-
// verification-evidence-design.md §B): Docker execution is opt-in and, if
// explicitly requested but unavailable, FAILS CLOSED — it must never
// silently fall back to running the command on the host.

import test from "node:test";
import assert from "node:assert/strict";

import { resolveSandboxExecutor, DockerUnavailableError } from "../src/sandbox/select-executor.mjs";
import { runSandboxedProcess } from "../src/sandbox/exec.mjs";
import { DockerExecutor } from "../src/sandbox/docker-executor.mjs";

test("sandbox:'local' (default) resolves to no docker executor", () => {
  assert.equal(resolveSandboxExecutor("local"), null);
  assert.equal(resolveSandboxExecutor(), null);
});

test("sandbox:'docker' with Docker available resolves to a DockerExecutor", () => {
  const executor = resolveSandboxExecutor("docker", { isAvailable: () => true });
  assert.ok(executor instanceof DockerExecutor);
});

test("sandbox:'docker' with Docker unavailable throws DockerUnavailableError, never falls back", () => {
  assert.throws(
    () => resolveSandboxExecutor("docker", { isAvailable: () => false }),
    (err) => err instanceof DockerUnavailableError && err.code === "DOCKER_UNAVAILABLE"
  );
});

test("runSandboxedProcess with sandbox:'docker' fails closed when Docker is unavailable on this machine", async () => {
  // This dev/CI box has no Docker daemon reachable (confirmed via
  // DockerExecutor.isAvailable() below) — so this exercises the real
  // fail-closed path end-to-end rather than an injected fake. If a future
  // CI runner *does* have Docker, this assertion is skipped rather than
  // asserting a fail path that would no longer be true — same gating
  // convention as harness/tests/h6-sandbox-docker.test.mjs's SKIP_DOCKER.
  if (DockerExecutor.isAvailable()) return;

  await assert.rejects(
    () => runSandboxedProcess("echo", ["hi"], { sandbox: "docker", cwd: process.cwd() }),
    (err) => err.code === "DOCKER_UNAVAILABLE"
  );
});

test("runSandboxedProcess with sandbox:'local' (default) is unaffected", async () => {
  const result = await runSandboxedProcess("echo", ["hi"], { cwd: process.cwd() });
  assert.equal(result.ok, true);
});

test("UPSTAGE_SANDBOX=docker env var is a default when args.sandbox is omitted", async () => {
  // Same gating as the fail-closed test above — GitHub Actions' hosted
  // ubuntu-latest runners ship Docker pre-installed and running, so on a
  // machine where Docker genuinely IS available this env-default request
  // succeeds instead of failing closed. That's still correct behavior
  // (this test only asserts the env var reaches sandbox selection, not
  // that Docker is unavailable) — verified separately below when Docker
  // is available, rather than asserting a rejection that wouldn't hold.
  const prev = process.env.UPSTAGE_SANDBOX;
  process.env.UPSTAGE_SANDBOX = "docker";
  try {
    if (DockerExecutor.isAvailable()) {
      const result = await runSandboxedProcess("echo", ["hi"], { cwd: process.cwd() });
      assert.equal(result.ok, true);
      return;
    }
    await assert.rejects(
      () => runSandboxedProcess("echo", ["hi"], { cwd: process.cwd() }),
      (err) => err.code === "DOCKER_UNAVAILABLE"
    );
  } finally {
    if (prev === undefined) delete process.env.UPSTAGE_SANDBOX;
    else process.env.UPSTAGE_SANDBOX = prev;
  }
});

test("sandbox:'docker' never forwards the full host process.env by default (no wholesale env leak)", async () => {
  // Real bug found on a Docker-available machine (2026-09-19): exec.mjs
  // defaults `env` to the full `process.env` for the LOCAL executor (always
  // correct — local execution already runs in the host's own env) but was
  // forwarding that same default into the Docker path too, which on this
  // Windows dev box overwrote the container's Linux PATH with the host's
  // Windows PATH and broke binary lookup entirely — and on any host,
  // leaks every host env var (secrets included) into the container by
  // default. Exactly what the design doc's Docker security taste
  // ("env allowlist, never wholesale process.env") ruled out.
  if (!DockerExecutor.isAvailable()) return;
  const sentinelName = "UPSTAGE_TEST_HOST_ONLY_SENTINEL";
  process.env[sentinelName] = "leaked-if-present";
  try {
    const result = await runSandboxedProcess("env", [], { sandbox: "docker", cwd: process.cwd() });
    assert.equal(result.ok, true, result.stderr);
    assert.ok(!result.stdout.includes(sentinelName), "host env var must not be forwarded into the Docker container by default");
  } finally {
    delete process.env[sentinelName];
  }
});

test("explicit sandbox:'local' overrides UPSTAGE_SANDBOX=docker", async () => {
  const prev = process.env.UPSTAGE_SANDBOX;
  process.env.UPSTAGE_SANDBOX = "docker";
  try {
    const result = await runSandboxedProcess("echo", ["hi"], { cwd: process.cwd(), sandbox: "local" });
    assert.equal(result.ok, true);
  } finally {
    if (prev === undefined) delete process.env.UPSTAGE_SANDBOX;
    else process.env.UPSTAGE_SANDBOX = prev;
  }
});
