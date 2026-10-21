// REAL Docker integration tests — nothing here is mocked. When Docker is not
// available every test is reported as SKIPPED (not passed). Mocked isolation
// tests live in h11.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DockerSandbox } from "../src/sandbox/docker.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";
import { CodingAgent } from "../src/agent/interface.mjs";
import { confineRegistryToSandbox } from "../src/agent/sandboxed-tools.mjs";
import { buildAgentRegistry } from "../src/agent/adapters/upstage.mjs";
import { ToolRegistry } from "../../src/tools/registry.mjs";
import { runShellTool } from "../../src/tools/builtin/run-shell.mjs";
import { readFileTool } from "../../src/tools/builtin/read-file.mjs";

const DOCKER = process.env.SKIP_DOCKER !== "1" && DockerSandbox.isAvailable();
const skip = DOCKER ? false : "Docker not available — NOT EXECUTED";
const IMAGE = process.env.HARNESS_TEST_IMAGE || "alpine:3.20";
const NODE_IMAGE = process.env.HARNESS_TEST_NODE_IMAGE || "node:22-alpine";
const FLAKY = resolve(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/flaky-test");

function sandboxFor(dir, sandbox = {}) {
  const sb = new DockerSandbox({ id: "h12", sandbox: { type: "docker", image: IMAGE, timeout: 30, network: "none", memory: "256m", cpus: 1, pids: 64, ...sandbox } });
  return sb.setup(dir).then(() => sb);
}

async function withWorkspace(fn) {
  const root = mkdtempSync(join(tmpdir(), "h12-"));
  const ws = join(root, "workspace");
  mkdirSync(ws);
  try {
    return await fn({ root, ws });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("DockerSandbox — real isolation", { skip }, () => {
  it("cannot read a host file outside the workspace", async () => {
    await withWorkspace(async ({ root, ws }) => {
      writeFileSync(join(root, "host-secret.txt"), "TOP-SECRET-H12");
      writeFileSync(join(ws, "visible.txt"), "ok");
      const sb = await sandboxFor(ws);
      try {
        const inside = await sb.execShell("cat visible.txt");
        assert.equal(inside.stdout.trim(), "ok", "workspace is mounted");
        const r = await sb.execShell(`cat ../host-secret.txt; cat /host-secret.txt; grep -rs TOP-SECRET-H12 / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; echo done`);
        assert.ok(!r.stdout.includes("TOP-SECRET-H12"), "host file must be unreachable");
        assert.match(r.stdout, /done/);
      } finally {
        await sb.teardown();
      }
    });
  });

  it("network is disabled: only loopback exists and outbound requests fail", async () => {
    await withWorkspace(async ({ ws }) => {
      const sb = await sandboxFor(ws);
      try {
        const ifaces = await sb.execShell("ls /sys/class/net");
        assert.deepEqual(ifaces.stdout.trim().split(/\s+/), ["lo"]);
        const r = await sb.execShell("wget -q -T 5 -O- http://1.1.1.1/ || exit 7");
        assert.equal(r.exitCode, 7);
        assert.equal(sb.describe().network.effective, "none");
      } finally {
        await sb.teardown();
      }
    });
  });

  it("enforces memory, cpu and pids limits (cgroup values) and read-only root", async () => {
    await withWorkspace(async ({ ws }) => {
      const sb = await sandboxFor(ws);
      try {
        const r = await sb.execShell("cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max");
        const [mem, pids, cpu] = r.stdout.trim().split("\n");
        assert.equal(Number(mem), 256 * 1024 * 1024);
        assert.equal(pids.trim(), "64");
        assert.match(cpu, /^100000 100000$/);
        const ro = await sb.execShell("touch /etc/h12 2>&1 || echo READONLY");
        assert.match(ro.stdout, /READONLY/);
        const fork = await sb.execShell("i=0; while [ $i -lt 100 ]; do sleep 20 & i=$((i+1)); done 2>&1; echo spawned", { timeoutMs: 15000 });
        assert.match(fork.stdout + fork.stderr, /fork|Resource temporarily unavailable|can't/i, "pids limit must stop the 64th+ process");
      } finally {
        await sb.teardown();
      }
    });
  });

  it("timeout force-removes the container (no running task process left)", async () => {
    await withWorkspace(async ({ ws }) => {
      const sb = await sandboxFor(ws);
      try {
        const r = await sb.execShell("sleep 300", { timeoutMs: 3000 });
        assert.equal(r.timedOut, true);
        assert.equal(r.ok, false);
        const ps = spawnSync("docker", ["ps", "-aq", "--filter", `name=^${r.container}$`], { encoding: "utf8" });
        assert.equal(ps.stdout.trim(), "", `container ${r.container} must be gone`);
      } finally {
        await sb.teardown();
      }
    });
  });

  it("docker daemon-level failure is an infra error, not a check failure", async () => {
    await withWorkspace(async ({ ws }) => {
      const sb = new DockerSandbox({ sandbox: { type: "docker", image: "harness-h12-does-not-exist:nope", network: "none" } });
      try {
        await sb.setup(ws);
        const r = await sb.execShell("true", { timeoutMs: 60000 });
        assert.equal(r.ok, false);
        assert.ok(r.infraError, "missing image → infraError");
      } finally {
        await sb.teardown();
      }
    });
  });
});

describe("Agent tool execution is routed into Docker", { skip }, () => {
  it("run_shell runs in the container (model cannot opt out with sandbox:'local')", async () => {
    await withWorkspace(async ({ ws }) => {
      const sb = await sandboxFor(ws);
      const reg = new ToolRegistry({ allowHighRiskTools: true, permissionMode: "bypassPermissions" });
      reg.register(runShellTool);
      reg.register(readFileTool);
      confineRegistryToSandbox(reg, sb, ws);
      try {
        const r = await reg.execute("run_shell", { command: "ls /sys/class/net", sandbox: "local", networkBlocked: false }, { cwd: ws });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.data.stdout.trim(), "lo", "executed inside the network-less container");
      } finally {
        await sb.teardown();
      }
    });
  });

  it("symlink planted from inside the container cannot be used to read host files", async () => {
    await withWorkspace(async ({ root, ws }) => {
      writeFileSync(join(root, "host-secret.txt"), "TOP-SECRET-LN");
      const sb = await sandboxFor(ws);
      const reg = new ToolRegistry({ allowHighRiskTools: true, permissionMode: "bypassPermissions" });
      reg.register(runShellTool);
      reg.register(readFileTool);
      confineRegistryToSandbox(reg, sb, ws);
      try {
        // relative target: on the host this resolves to the workspace's parent
        await reg.execute("run_shell", { command: "ln -s ../host-secret.txt leak.txt" }, { cwd: ws });
        const r = await reg.execute("read_file", { path: "leak.txt" }, { cwd: ws });
        assert.equal(r.ok, false, "must not read through an escaping symlink");
        assert.ok(!JSON.stringify(r).includes("TOP-SECRET-LN"));
      } finally {
        await sb.teardown();
      }
    });
  });
});

describe("Live-adapter registry (buildAgentRegistry) on a real DockerSandbox", { skip }, () => {
  it("workspace edits succeed; a container-planted symlink cannot be written through by apply_patch", async () => {
    await withWorkspace(async ({ root, ws }) => {
      writeFileSync(join(root, "host-secret.txt"), "TOP-SECRET-AP");
      writeFileSync(join(ws, "a.txt"), "one\n");
      const sb = await sandboxFor(ws);
      const task = { id: "h12-reg", agent: { permissions: "bypassPermissions", tools: { allow: [], deny: [] } } };
      const { registry, tools } = await buildAgentRegistry(task, { workdir: ws, executor: sb });
      const exec = (n, a) => registry.execute(n, a, { cwd: ws });
      try {
        assert.ok(!tools.advertised.includes("web_fetch") && tools.advertised.includes("apply_patch"));
        assert.equal((await exec("write_file", { path: "a.txt", content: "two\n" })).ok, true);
        assert.equal((await exec("apply_patch", { patch: { version: 1, path: "a.txt", newContent: "three\n" } })).ok, true);
        const seen = await exec("run_shell", { command: "cat a.txt" });
        assert.equal(seen.data.stdout.trim(), "three", "the container sees the agent's edit");

        await exec("run_shell", { command: "ln -s ../host-secret.txt leak.txt" });
        const r = await exec("apply_patch", { patch: { version: 1, path: "leak.txt", newContent: "PWNED" } });
        assert.equal(r.ok, false);
        assert.equal(readFileSync(join(root, "host-secret.txt"), "utf8"), "TOP-SECRET-AP");
      } finally {
        await sb.teardown();
      }
    });
  });
});

describe("TaskRunner end-to-end on a docker task", { skip }, () => {
  const task = (checks) => ({
    id: "h12-e2e",
    repo: FLAKY,
    prompt: "fix",
    sandbox: { type: "docker", image: NODE_IMAGE, network: "none", timeout: 60, memory: "512m" },
    agent: { tools: { allow: [], deny: [] } },
    checks
  });
  const CHECKS = {
    fail_to_pass: [{ id: "data-fetch", command: "node --test --test-name-pattern test_data_fetch tests/fetcher.test.mjs" }],
    pass_to_pass: [{ id: "config-parse", command: "node --test --test-name-pattern 'test_config|test_parse' tests/fetcher.test.mjs" }],
    custom: [{ id: "in-container", command: "test -f /.dockerenv && ! ls /sys/class/net | grep -qv '^lo$'" }]
  };

  it("checks run inside the container and a correct patch passes", async () => {
    const run = await new TaskRunner().run(task(CHECKS), new MockAgent());
    assert.equal(run.status, "pass", JSON.stringify(run.outcome));
    assert.equal(run.sandbox.type, "docker");
    assert.equal(run.sandbox.enforced.network, true);
    assert.ok(run.evaluation.checks.custom[0].passed, "custom check proves execution inside docker");
  });

  it("a do-nothing agent fails the same docker task", async () => {
    class Noop extends CodingAgent {
      get id() { return "noop"; }
      get supportsSandbox() { return true; }
      async run() { return { ok: true, turns: 0, toolCalls: 0, usage: null, events: [] }; }
    }
    const run = await new TaskRunner().run(task(CHECKS), new Noop());
    assert.equal(run.status, "fail");
  });

  it("no harness containers are left running after the runs", () => {
    const ps = spawnSync("docker", ["ps", "-q", "--filter", "name=^harness-"], { encoding: "utf8" });
    assert.equal(ps.stdout.trim(), "");
    assert.ok(!existsSync(join(tmpdir(), "harness-h12-e2e-")));
  });
});
