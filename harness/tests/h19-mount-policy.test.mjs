// Trusted read-only mount policy (CPU-only; no Docker needed — the negative
// cases are rejected in resolveMountAsset / assertMountAllowed / loadTask /
// DockerSandbox.setup BEFORE any container is launched).
//
// Threat: sandbox.readonlyMounts could bind-mount an arbitrary host file into
// the container. Task YAML is not always trusted, so authorization must live in
// harness code, never in the task. These tests pin that boundary.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMountAsset, assertMountAllowed, MountPolicyError, _TRUSTED_MOUNT_ASSET_NAMES } from "../src/sandbox/mount-registry.mjs";
import { DockerSandbox } from "../src/sandbox/docker.mjs";
import { loadTask } from "../src/task/loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../fixtures");
const V3_GEN = join(FIXTURES, "tool-continuation-v3", "challenge.mjs");
const V3_REPO = resolve(FIXTURES, "tool-continuation-v3/repo");

let scratch, secret, extRoot;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), "h19-"));
  secret = join(scratch, "pretend_secret.txt");
  writeFileSync(secret, "FAKE-SECRET-DO-NOT-LEAK\n");
  extRoot = join(scratch, "ext");
  mkdirSync(extRoot);
  writeFileSync(join(extRoot, "asset.txt"), "ok");
});
after(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

function writeTask(yaml) {
  const p = join(scratch, `task-${Math.random().toString(16).slice(2)}.yaml`);
  writeFileSync(p, yaml);
  return p;
}

describe("mount policy — registry (authorization in harness code)", () => {
  it("resolves the trusted T3-v3 asset to its fixtures host + fixed container", () => {
    const m = resolveMountAsset("t3-challenge-v3");
    assert.equal(m.container, "/opt/t3/challenge.mjs");
    assert.ok(m.host.endsWith("tool-continuation-v3/challenge.mjs"));
  });

  it("the registry is non-empty and T3-v3 is present", () => {
    assert.ok(_TRUSTED_MOUNT_ASSET_NAMES.includes("t3-challenge-v3"));
  });

  it("an unknown asset name is rejected (fail-closed)", () => {
    assert.throws(() => resolveMountAsset("evil"), MountPolicyError);
    assert.throws(() => resolveMountAsset("../../etc/passwd"), MountPolicyError);
    assert.throws(() => resolveMountAsset(undefined), MountPolicyError);
  });
});

describe("mount policy — assertMountAllowed (independent allowlist)", () => {
  it("allows a real file inside the fixtures root", () => {
    const r = assertMountAllowed({ host: V3_GEN, container: "/opt/t3/challenge.mjs" });
    assert.equal(r.container, "/opt/t3/challenge.mjs");
  });

  it("rejects an arbitrary absolute host path outside the roots", () => {
    assert.throws(() => assertMountAllowed({ host: secret, container: "/opt/leak" }), /outside the trusted asset roots/);
  });

  it("rejects a symlink that escapes the fixtures root (realpath resolved)", () => {
    const link = join(scratch, "escape.mjs");
    symlinkSync(secret, link);
    assert.throws(() => assertMountAllowed({ host: link, container: "/opt/x" }), /outside the trusted asset roots/);
  });

  it("rejects a non-existent host path", () => {
    assert.throws(() => assertMountAllowed({ host: join(scratch, "nope"), container: "/opt/x" }), /does not exist/);
  });

  it("rejects a container path inside /workspace (cannot shadow the workspace)", () => {
    assert.throws(() => assertMountAllowed({ host: V3_GEN, container: "/workspace/challenge.mjs" }), /outside \/workspace/);
    assert.throws(() => assertMountAllowed({ host: V3_GEN, container: "relative/path" }), /absolute/);
  });

  it("an operator-configured root (HARNESS_MOUNT_ALLOW_ROOTS) extends the allowlist — but is NOT task input", () => {
    const asset = join(extRoot, "asset.txt");
    assert.throws(() => assertMountAllowed({ host: asset, container: "/opt/x" }), MountPolicyError); // not allowed by default
    const saved = process.env.HARNESS_MOUNT_ALLOW_ROOTS;
    process.env.HARNESS_MOUNT_ALLOW_ROOTS = extRoot;
    try {
      const r = assertMountAllowed({ host: asset, container: "/opt/x" });
      assert.equal(r.container, "/opt/x");
    } finally {
      if (saved === undefined) delete process.env.HARNESS_MOUNT_ALLOW_ROOTS; else process.env.HARNESS_MOUNT_ALLOW_ROOTS = saved;
    }
  });
});

describe("mount policy — loader (untrusted task YAML cannot name host paths)", () => {
  const base = (mounts) => [
    "id: mnt-test",
    "repo: " + JSON.stringify(V3_REPO),
    "prompt: 'x'",
    `sandbox: { type: docker, image: node:22-alpine, readonlyMounts: ${mounts} }`,
    "checks: { pass_to_pass: [ { id: p, command: 'true' } ] }"
  ].join("\n");

  it("a task referencing the trusted asset resolves to {host, container}", () => {
    const t = loadTask(writeTask(base("[ { asset: t3-challenge-v3 } ]")));
    assert.equal(t.sandbox.readonlyMounts.length, 1);
    assert.equal(t.sandbox.readonlyMounts[0].container, "/opt/t3/challenge.mjs");
    assert.ok(t.sandbox.readonlyMounts[0].host.endsWith("tool-continuation-v3/challenge.mjs"));
  });

  it("a task supplying a raw host path (no asset) is rejected", () => {
    assert.throws(() => loadTask(writeTask(base(`[ { host: ${JSON.stringify(secret)}, container: /opt/leak } ]`))), /must be \{ asset/);
  });

  it("a task adding host/container alongside an asset is rejected", () => {
    assert.throws(() => loadTask(writeTask(base(`[ { asset: t3-challenge-v3, host: ${JSON.stringify(secret)}, container: /opt/leak } ]`))), /may not specify host\/container/);
  });

  it("a task supplying only a container path is rejected (no asset)", () => {
    assert.throws(() => loadTask(writeTask(base("[ { container: /opt/leak } ]"))), /must be \{ asset/);
  });

  it("a task naming an unknown asset is rejected", () => {
    assert.throws(() => loadTask(writeTask(base("[ { asset: not-a-real-asset } ]"))), /unknown read-only mount asset/);
  });

  it("readonlyMounts that is not a list is rejected", () => {
    assert.throws(() => loadTask(writeTask(base("not-a-list"))), /must be a list/);
  });
});

describe("mount policy — DockerSandbox defense in depth (no container launched)", () => {
  it("setup() rejects a directly-constructed sandbox with an out-of-root host mount", async () => {
    const sb = new DockerSandbox({ sandbox: { type: "docker", image: "node:22-alpine", readonlyMounts: [{ host: secret, container: "/opt/leak" }] } });
    await assert.rejects(() => sb.setup(scratch), MountPolicyError);
  });

  it("setup() accepts a registry-resolved mount and canonicalises the host", async () => {
    const m = resolveMountAsset("t3-challenge-v3");
    const sb = new DockerSandbox({ sandbox: { type: "docker", image: "node:22-alpine", readonlyMounts: [m] } });
    await sb.setup(scratch);
    assert.equal(sb.readonlyMounts[0].container, "/opt/t3/challenge.mjs");
    await sb.teardown();
  });
});
