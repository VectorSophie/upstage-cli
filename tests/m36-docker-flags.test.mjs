// Tests for src/sandbox/docker-flags.mjs (3.3.0 Thread B, Task B.2) — the
// shared `docker run` security-flag builder. Extracted so the main agent's
// DockerExecutor (src/sandbox/docker-executor.mjs) and the eval harness's
// DockerSandbox (harness/src/sandbox/docker.mjs) build the exact same
// `--network none`/`--read-only`/`--tmpfs`/resource-cap flags from one
// place instead of two independently-drifting copies.

import test from "node:test";
import assert from "node:assert/strict";

import { buildDockerRunArgs } from "../src/sandbox/docker-flags.mjs";

test("defaults to network:none, read-only root, and a noexec/nosuid scoped tmpfs", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/work" });

  assert.ok(args.includes("--network"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--tmpfs"));
  assert.match(args[args.indexOf("--tmpfs") + 1], /noexec,nosuid/);
});

test("network:'bridge' opts out of --network none", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/work", network: "bridge" });
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
});

test("bind-mounts workdir read-write at the container cwd", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/my-work" });
  assert.ok(args.includes("-v"));
  assert.equal(args[args.indexOf("-v") + 1], "/tmp/my-work:/workspace:rw");
  assert.ok(args.includes("-w"));
  assert.equal(args[args.indexOf("-w") + 1], "/workspace");
});

test("applies memory and cpu resource caps", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/work", memory: "256m", cpus: "1" });
  assert.equal(args[args.indexOf("--memory") + 1], "256m");
  assert.equal(args[args.indexOf("--cpus") + 1], "1");
});

test("never includes --privileged or a docker socket mount", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/work" });
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.some((a) => typeof a === "string" && a.includes("docker.sock")));
});

test("passes env vars via -e, never dumps process.env wholesale", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/work", env: { FOO: "bar" } });
  const eIndex = args.indexOf("-e");
  assert.ok(eIndex >= 0);
  assert.equal(args[eIndex + 1], "FOO=bar");
});

test("always runs with --rm so containers never accumulate", () => {
  const args = buildDockerRunArgs({ image: "ubuntu:22.04", workdir: "/tmp/work" });
  assert.ok(args.includes("--rm"));
});

test("image and trailing command are appended last, in order", () => {
  const args = buildDockerRunArgs({ image: "alpine", workdir: "/tmp/work", command: "echo", commandArgs: ["hi"] });
  assert.deepEqual(args.slice(-3), ["alpine", "echo", "hi"]);
});
