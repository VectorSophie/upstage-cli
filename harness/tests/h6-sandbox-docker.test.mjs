import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { selectSandbox } from "../src/sandbox/manager.mjs";
import { NativeSandbox } from "../src/sandbox/native.mjs";
import { DockerSandbox } from "../src/sandbox/docker.mjs";

const SKIP_DOCKER = process.env.SKIP_DOCKER === "1" || !DockerSandbox.isAvailable();

function makeTask(overrides = {}) {
  return {
    id: "sandbox-test",
    sandbox: { type: "native", timeout: 10, network: "none", memory: "128m" },
    ...overrides
  };
}

// ── selectSandbox ─────────────────────────────────────────────────────────────

describe("selectSandbox — manager", () => {
  it("returns NativeSandbox for type:native", () => {
    const sb = selectSandbox(makeTask({ sandbox: { type: "native" } }));
    assert.ok(sb instanceof NativeSandbox);
    assert.equal(sb.type, "native");
  });

  it("falls back to native when docker unavailable and type:docker requested", () => {
    if (!SKIP_DOCKER) return; // Docker IS available — skip this fallback test
    const sb = selectSandbox(makeTask({ sandbox: { type: "docker", image: "python:3.12-slim" } }));
    assert.ok(sb instanceof NativeSandbox);
  });

  it("returns DockerSandbox when docker available and type:docker", () => {
    if (SKIP_DOCKER) return; // skip when Docker unavailable
    const sb = selectSandbox(makeTask({ sandbox: { type: "docker", image: "alpine" } }));
    assert.ok(sb instanceof DockerSandbox);
  });

  it("defaults to native when sandbox.type omitted", () => {
    const sb = selectSandbox({ id: "x", sandbox: {} });
    assert.ok(sb instanceof NativeSandbox);
  });
});

// ── NativeSandbox ─────────────────────────────────────────────────────────────

describe("NativeSandbox — setup / teardown no-ops", () => {
  it("setup() resolves without error", async () => {
    const sb = new NativeSandbox(makeTask());
    await assert.doesNotReject(() => sb.setup());
  });

  it("teardown() resolves without error", async () => {
    const sb = new NativeSandbox(makeTask());
    await assert.doesNotReject(() => sb.teardown());
  });

  it("copyOut() resolves without error", async () => {
    const sb = new NativeSandbox(makeTask());
    await assert.doesNotReject(() => sb.copyOut("/a", "/b"));
  });
});

// ── DockerSandbox.isAvailable() ───────────────────────────────────────────────

describe("DockerSandbox.isAvailable()", () => {
  it("returns a boolean", () => {
    assert.equal(typeof DockerSandbox.isAvailable(), "boolean");
  });
});

// ── Docker exec tests (skipped when SKIP_DOCKER=1) ───────────────────────────

describe("DockerSandbox — exec (skipped when SKIP_DOCKER=1)", () => {
  it("runs echo in container", async () => {
    if (SKIP_DOCKER) return;
    const tmp = mkdtempSync(join(tmpdir(), "h6-docker-"));
    try {
      const sb = new DockerSandbox(makeTask({ sandbox: { type: "docker", image: "alpine", timeout: 30, network: "none", memory: "128m" } }));
      await sb.setup(tmp);
      const result = await sb.exec("echo", ["hello-docker"], { cwd: tmp });
      await sb.teardown();
      assert.ok(result.ok);
      assert.ok(result.stdout.includes("hello-docker"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("non-zero exit code → ok:false", async () => {
    if (SKIP_DOCKER) return;
    const tmp = mkdtempSync(join(tmpdir(), "h6-exit-"));
    try {
      const sb = new DockerSandbox(makeTask({ sandbox: { type: "docker", image: "alpine", timeout: 30, network: "none", memory: "128m" } }));
      await sb.setup(tmp);
      const result = await sb.exec("sh", ["-c", "exit 42"], { cwd: tmp });
      await sb.teardown();
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 42);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("network:none blocks outbound requests", async () => {
    if (SKIP_DOCKER) return;
    const tmp = mkdtempSync(join(tmpdir(), "h6-net-"));
    try {
      const sb = new DockerSandbox(makeTask({ sandbox: { type: "docker", image: "alpine", timeout: 30, network: "none", memory: "128m" } }));
      await sb.setup(tmp);
      const result = await sb.exec("wget", ["-q", "-O-", "https://example.com"], { cwd: tmp });
      await sb.teardown();
      assert.equal(result.ok, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("workdir files visible inside container", async () => {
    if (SKIP_DOCKER) return;
    const tmp = mkdtempSync(join(tmpdir(), "h6-files-"));
    try {
      writeFileSync(join(tmp, "sentinel.txt"), "harness-test");
      const sb = new DockerSandbox(makeTask({ sandbox: { type: "docker", image: "alpine", timeout: 30, network: "none", memory: "128m" } }));
      await sb.setup(tmp);
      const result = await sb.exec("cat", ["sentinel.txt"], { cwd: tmp });
      await sb.teardown();
      assert.ok(result.ok);
      assert.ok(result.stdout.includes("harness-test"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
