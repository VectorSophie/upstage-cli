// Regression tests for the 2026-10 harness correctness/isolation audit.
// Pure Node — no Docker, no model API. Docker integration lives in h12.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { TaskRunner, makeRunId } from "../src/task/runner.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";
import { CodingAgent } from "../src/agent/interface.mjs";
import { AgentRegistry } from "../src/agent/registry.mjs";
import { UpstageAgent, extractUsage } from "../src/agent/adapters/upstage.mjs";
import { ClaudeCodeAgent } from "../src/agent/adapters/claude-code.mjs";
import { resolveAgent } from "../src/cli/commands/run.mjs";
import { determineOutcome } from "../src/evaluation/checks.mjs";
import { passAtK, passHatK, summarizeAttempts } from "../src/evaluation/pass-at-k.mjs";
import { CostTracker } from "../src/tracking/cost-tracker.mjs";
import { createToolPolicy, enforceToolPolicy, canonicalToolName } from "../src/agent/tool-policy.mjs";
import { confineRegistryToSandbox, IsolationError } from "../src/agent/sandboxed-tools.mjs";
import { selectSandbox } from "../src/sandbox/manager.mjs";
import { NativeSandbox } from "../src/sandbox/native.mjs";
import { DockerSandbox } from "../src/sandbox/docker.mjs";
import { loadSwebenchFile } from "../src/task/loaders/swebench.mjs";
import { redactSecrets, writeReport } from "../src/report/generator.mjs";
import { ToolRegistry } from "../../src/tools/registry.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FLAKY = resolve(HERE, "../fixtures/flaky-test");
const NODE = JSON.stringify(process.execPath);

function makeTask(overrides = {}) {
  return {
    id: "h11-task",
    version: 1,
    repo: FLAKY,
    prompt: "Fix the bug.",
    sandbox: { type: "native", timeout: 30, network: "none" },
    agent: { permissions: "acceptEdits", maxTurns: 3, maxTokens: 8192, tools: { allow: [], deny: [] } },
    checks: { fail_to_pass: [], pass_to_pass: [], custom: [] },
    scoring: { costBudgetUsd: 1.0 },
    expectedPatchScope: [],
    expectedMaxLines: 50,
    ...overrides
  };
}

const FLAKY_CHECKS = {
  fail_to_pass: [{ id: "data-fetch", command: 'node --test --test-name-pattern "test_data_fetch" tests/fetcher.test.mjs', timeout: 20 }],
  pass_to_pass: [{ id: "config-parse", command: 'node --test --test-name-pattern "test_config|test_parse" tests/fetcher.test.mjs', timeout: 20 }]
};

class FnAgent extends CodingAgent {
  constructor(fn, id = "fn-agent") {
    super();
    this._fn = fn;
    this._id = id;
  }
  get id() { return this._id; }
  async run(task, ctx) { return this._fn(task, ctx); }
}

const CAN_SYMLINK = (() => {
  const d = mkdtempSync(join(tmpdir(), "h11-ln-"));
  try { symlinkSync(join(d, "a"), join(d, "b")); return true; } catch { return false; } finally { rmSync(d, { recursive: true, force: true }); }
})();

const noop = () => ({ ok: true, turns: 1, toolCalls: 0, usage: null, events: [] });

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `h11-${prefix}-`));
}

// ── 1. Patch minimality uses the real diff ──────────────────────────────────
describe("scoring uses actual patch measurements", () => {
  it("legitimate patch → nonzero changed lines and patchMinimality < 1", async () => {
    const run = await new TaskRunner().run(makeTask({ checks: FLAKY_CHECKS }), new MockAgent());
    assert.equal(run.status, "pass");
    assert.ok(run.metrics.patch.linesAdded + run.metrics.patch.linesRemoved > 0);
    assert.equal(run.metrics.patch.filesChanged, 1);
    assert.ok(run.evaluation.breakdown.patchMinimalityScore < 1, "minimality must reflect the patch");
    assert.match(run.patch.model_patch, /await fetchData/);
    assert.equal(run.evaluation.compositeIsAuthoritative, false);
  });

  it("check side effects (pycache etc.) never leak into the patch", async () => {
    const task = makeTask({
      checks: {
        fail_to_pass: [{ id: "f", command: `${NODE} -e "const fs=require('fs');fs.mkdirSync('__pycache__',{recursive:true});fs.writeFileSync('__pycache__/x.pyc','b');fs.writeFileSync('check-artifact.txt','x');process.exit(fs.existsSync('fixed.txt')?0:1)"` }]
      }
    });
    const agent = new FnAgent((_t, { workdir }) => { writeFileSync(join(workdir, "fixed.txt"), "yes\n"); return noop(); });
    const run = await new TaskRunner().run(task, agent);
    assert.equal(run.status, "pass");
    assert.deepEqual(run.patch.filesChanged, ["fixed.txt"]);
  });
});

// ── 2/3. Outcome determination ───────────────────────────────────────────────
describe("status derives only from executed required checks", () => {
  it("failed required check cannot be reported as success", async () => {
    const run = await new TaskRunner().run(makeTask({ checks: FLAKY_CHECKS }), new FnAgent(noop));
    assert.equal(run.status, "fail");
    assert.equal(run.outcome.reason, "required_check_failed");
    assert.notEqual(run.failure, null);
  });

  it("failed required custom check fails the run even when fail_to_pass passes", async () => {
    const task = makeTask({ checks: { ...FLAKY_CHECKS, custom: [{ id: "lint", command: `${NODE} -e "process.exit(3)"` }] } });
    const run = await new TaskRunner().run(task, new MockAgent());
    assert.equal(run.status, "fail");
    assert.equal(run.outcome.detail, "lint");
  });

  it("optional (required:false) check failure does not fail the run", async () => {
    const task = makeTask({ checks: { ...FLAKY_CHECKS, custom: [{ id: "style", command: `${NODE} -e "process.exit(3)"`, required: false }] } });
    const run = await new TaskRunner().run(task, new MockAgent());
    assert.equal(run.status, "pass");
  });

  it("evaluation with no checks is incomplete, never pass", async () => {
    const run = await new TaskRunner().run(makeTask(), new MockAgent());
    assert.equal(run.status, "incomplete");
    assert.equal(run.outcome.reason, "no_required_acceptance_checks");
    assert.equal(run.failure.dimension, "evaluation");
    assert.equal(run.evaluation.passAtK.k1, null);
  });

  it("pass_to_pass-only task is incomplete (a no-op agent would pass it)", () => {
    const o = determineOutcome({ checks: { pass_to_pass: [{ id: "p", passed: true, required: true }] } });
    assert.equal(o.status, "incomplete");
  });

  it("check that could not execute → error, not fail/pass", () => {
    const o = determineOutcome({ checks: { fail_to_pass: [{ id: "f", passed: false, infraError: "docker daemon error" }] } });
    assert.equal(o.status, "error");
    assert.equal(o.reason, "check_infrastructure_error");
  });

  it("baseline rejects a task whose fail_to_pass already passes", async () => {
    const task = makeTask({ checks: { fail_to_pass: [{ id: "trivial", command: `${NODE} -e "process.exit(0)"` }] } });
    await assert.rejects(() => new TaskRunner().run(task, new MockAgent()), /Baseline invalid/);
  });

  it("check timeout is classified as runtime/timeout", async () => {
    const task = makeTask({
      checks: { fail_to_pass: [{ id: "slow", command: `${NODE} -e "if(require('fs').existsSync('go'))setInterval(()=>{},1000);else process.exit(1)"`, timeout: 2 }] }
    });
    const agent = new FnAgent((_t, { workdir }) => { writeFileSync(join(workdir, "go"), ""); return noop(); });
    const run = await new TaskRunner().run(task, agent);
    assert.equal(run.status, "fail");
    assert.equal(run.outcome.reason, "check_timeout");
    assert.equal(run.failure.symptom, "timeout");
  });
});

// ── 4/5. Tool policy ─────────────────────────────────────────────────────────
function fakeTool(name, source = "builtin") {
  return { name, source, risk: "low", inputSchema: { type: "object", properties: {} }, execute: async (args) => ({ ran: name, args }) };
}

function registryWith(names) {
  const reg = new ToolRegistry({ allowHighRiskTools: true, permissionMode: "bypassPermissions" });
  for (const n of names) reg.register(fakeTool(n));
  return reg;
}

describe("tool allow/deny enforcement", () => {
  const ALL = ["read_file", "write_file", "run_shell", "mcp__fs__write_file", "Write-File", "fs.write_file", "web_fetch"];

  it("allowed tool is advertised and executes", async () => {
    const reg = registryWith(ALL);
    enforceToolPolicy(reg, createToolPolicy({ allow: ["read_file"] }));
    assert.deepEqual(reg.toModelTools().map((t) => t.function.name), ["read_file"]);
    const r = await reg.execute("read_file", { path: "x" });
    assert.equal(r.ok, true);
  });

  it("denied tool is not advertised and invocation is rejected server-side", async () => {
    const reg = registryWith(ALL);
    const { removed } = enforceToolPolicy(reg, createToolPolicy({ deny: ["run_shell"] }));
    assert.ok(removed.includes("run_shell"));
    assert.ok(!reg.toModelTools().some((t) => t.function.name === "run_shell"));
    const r = await reg.execute("run_shell", { command: "ls" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "TOOL_DENIED");
  });

  it("deny beats allow", async () => {
    const reg = registryWith(ALL);
    enforceToolPolicy(reg, createToolPolicy({ allow: ["write_file", "read_file"], deny: ["write_file"] }));
    assert.deepEqual(reg.list().map((t) => t.name), ["read_file"]);
    assert.equal((await reg.execute("write_file", {})).error.code, "TOOL_DENIED");
  });

  it("aliases/namespaced variants cannot bypass the denylist", async () => {
    const reg = registryWith(ALL);
    enforceToolPolicy(reg, createToolPolicy({ deny: ["write_file"] }));
    for (const alias of ["write_file", "mcp__fs__write_file", "Write-File", "fs.write_file", "WRITE_FILE", "srv/write-file", "a:write_file"]) {
      assert.equal(reg.has(alias), false, `${alias} must not be registered`);
      const r = await reg.execute(alias, {});
      assert.equal(r.ok, false, `${alias} must be rejected`);
      assert.equal(r.error.code, "TOOL_DENIED");
    }
    assert.ok(reg.has("read_file"));
  });

  it("allowlist matches exact names only (namespaced variant is not allowed)", () => {
    const reg = registryWith(ALL);
    enforceToolPolicy(reg, createToolPolicy({ allow: ["write_file"] }));
    assert.deepEqual(reg.list().map((t) => t.name), ["write_file"]);
  });

  it("tools registered after enforcement are filtered too", async () => {
    const reg = registryWith(["read_file"]);
    enforceToolPolicy(reg, createToolPolicy({ deny: ["web_fetch"] }));
    reg.register(fakeTool("mcp__net__web_fetch", "mcp"));
    assert.equal(reg.has("mcp__net__web_fetch"), false);
  });

  it("unknown tool → TOOL_NOT_FOUND; malformed calls rejected deterministically", async () => {
    const reg = registryWith(ALL);
    enforceToolPolicy(reg, createToolPolicy({}));
    assert.equal((await reg.execute("does_not_exist", {})).error.code, "TOOL_NOT_FOUND");
    assert.equal((await reg.execute(undefined, {})).error.code, "INVALID_TOOL_CALL");
    assert.equal((await reg.execute("", {})).error.code, "INVALID_TOOL_CALL");
    assert.equal((await reg.execute({ name: "read_file" }, {})).error.code, "INVALID_TOOL_CALL");
    for (const bad of ["{\"path\":1}", ["a"], null, 42]) {
      const r = await reg.execute("read_file", bad);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "INVALID_TOOL_CALL");
    }
  });

  it("malformed policy config is rejected", () => {
    assert.throws(() => createToolPolicy({ deny: "write_file" }), /arrays of non-empty strings/);
    assert.throws(() => createToolPolicy({ allow: [""] }), /arrays of non-empty strings/);
  });

  it("canonicalisation strips namespaces and separators", () => {
    assert.equal(canonicalToolName("mcp__fs__Write-File"), "write_file");
    assert.equal(canonicalToolName("srv.write.file"), "file");
  });
});

// ── Docker tool confinement (mock executor — no Docker needed) ─────────────
describe("docker tool confinement (mocked executor)", () => {
  const fakeExecutor = () => {
    const calls = [];
    return { type: "docker", timeoutMs: 5000, calls, exec: async (bin, args, opts) => { calls.push({ bin, args, opts }); return { ok: true, exitCode: 0, stdout: "in-container", stderr: "", timedOut: false }; } };
  };

  it("routes run_shell into the executor and drops host-only tools", async () => {
    const dir = tmp("confine");
    try {
      const reg = registryWith(["read_file", "run_shell", "run_tests", "web_fetch", "run_linter", "browser_open"]);
      const ex = fakeExecutor();
      const { removed } = confineRegistryToSandbox(reg, ex, dir);
      assert.deepEqual(removed, ["browser_open", "run_linter", "web_fetch"]);
      const r = await reg.execute("run_shell", { command: "ls -la", sandbox: "local" });
      assert.equal(r.ok, true);
      assert.equal(r.data.stdout, "in-container");
      assert.deepEqual(ex.calls[0].bin, "ls");
      assert.ok(!("sandbox" in reg.get("run_shell").inputSchema.properties), "model must not be able to choose the sandbox");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicitly allowing a host-only tool on a docker task fails closed", () => {
    const reg = registryWith(["read_file", "web_fetch"]);
    assert.throws(() => confineRegistryToSandbox(reg, fakeExecutor(), tmpdir(), { explicitAllow: ["web_fetch"] }), IsolationError);
  });

  it("file tools reject paths that resolve outside the workspace", async () => {
    const dir = tmp("guard");
    const outside = tmp("outside");
    try {
      writeFileSync(join(outside, "secret.txt"), "host-secret");
      const reg = registryWith(["read_file"]);
      confineRegistryToSandbox(reg, fakeExecutor(), dir);
      const r = await reg.execute("read_file", { path: join(outside, "secret.txt") });
      assert.equal(r.ok, false);
      assert.match(r.error.message, /outside the task workspace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("file tools reject a symlink that escapes the workspace", { skip: CAN_SYMLINK ? false : "host cannot create symlinks (Windows without Developer Mode)" }, async () => {
    const dir = tmp("guard-ln");
    const outside = tmp("outside-ln");
    try {
      writeFileSync(join(outside, "secret.txt"), "host-secret");
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
      const reg = registryWith(["read_file"]);
      confineRegistryToSandbox(reg, fakeExecutor(), dir);
      const r = await reg.execute("read_file", { path: "link.txt" });
      assert.equal(r.ok, false, "symlink escape must be rejected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── Sandbox selection / fail-closed ──────────────────────────────────────────
describe("sandbox selection never silently falls back", () => {
  it("docker requested + unavailable → throws", () => {
    assert.throws(() => selectSandbox({ id: "t", sandbox: { type: "docker" } }, { isDockerAvailable: () => false }), /refusing to fall back/);
  });

  it("network allowlist is reported as unsupported, not pretended", () => {
    assert.throws(() => new DockerSandbox({ sandbox: { type: "docker", network: "allowlist" } }), /not supported/);
  });

  it("native sandbox reports that network isolation is not enforced", () => {
    const d = new NativeSandbox({ sandbox: { network: "none" } }).describe();
    assert.equal(d.enforced.network, false);
    assert.ok(d.warnings.length > 0);
  });

  it("host-executing agent is refused on a docker task", async () => {
    const fakeDocker = { type: "docker", setup: async () => {}, teardown: async () => {}, describe: () => ({}) };
    const runner = new TaskRunner({ selectSandbox: () => fakeDocker });
    const task = makeTask({ sandbox: { type: "docker" }, checks: FLAKY_CHECKS });
    await assert.rejects(() => runner.run(task, new ClaudeCodeAgent()), /cannot be isolated/);
  });
});

// ── 8. Timeout kills the whole process tree (native) ─────────────────────────
describe("timeout leaves no running task process", () => {
  it("grandchild process is killed when a check times out", async () => {
    const dir = tmp("timeout");
    try {
      // shell → node parent → node grandchild that records its pid and never exits
      writeFileSync(join(dir, "parent.js"), `
        const { spawn } = require("child_process");
        const c = spawn(process.execPath, ["-e", "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(()=>{}, 1000)"], { stdio: "ignore" });
        setInterval(() => {}, 1000);
      `);
      const sb = new NativeSandbox({ sandbox: { timeout: 30 } });
      await sb.setup(dir);
      const r = await sb.execShell(`${NODE} parent.js`, { timeoutMs: 1500 });
      assert.equal(r.timedOut, true);
      assert.equal(r.ok, false);
      const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
      await new Promise((res) => setTimeout(res, 500));
      assert.throws(() => process.kill(pid, 0), "grandchild must be dead");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 9. Attempts start from identical repository state ───────────────────────
function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p.slice(dir.length)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("multiple attempts start from identical repository state", () => {
  it("each attempt sees the pristine fixture even after a previous attempt mutated it", async () => {
    const seen = [];
    const dirs = [];
    const agent = new FnAgent((_t, { workdir }) => {
      seen.push(treeHash(workdir));
      dirs.push(workdir);
      writeFileSync(join(workdir, "fetcher.mjs"), "garbage");
      writeFileSync(join(workdir, "new-file.txt"), "x");
      return noop();
    });
    const fixtureBefore = treeHash(FLAKY);
    const runner = new TaskRunner();
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await runner.run(makeTask({ checks: FLAKY_CHECKS }), agent));
    assert.equal(new Set(seen).size, 1, "all attempts must start from the same tree");
    assert.equal(new Set(dirs).size, 3, "each attempt gets its own workspace");
    assert.equal(new Set(runs.map((r) => r.id)).size, 3, "run ids must be unique");
    assert.equal(new Set(runs.map((r) => r.patch.initialCommit)).size >= 1, true);
    assert.equal(treeHash(FLAKY), fixtureBefore, "fixture must never be modified");
    for (const d of dirs) assert.equal(existsSync(d), false, "workspace removed after attempt");
  });

  it("pinned commit + hidden test patch: agent sees base commit, test patch applied only for checks", async () => {
    const repo = tmp("pinned");
    const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdio: "pipe" }).toString().trim();
    try {
      git("init", "-q");
      writeFileSync(join(repo, "lib.js"), "module.exports = (a, b) => a - b;\n");
      git("add", "-A"); git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(repo, "later.txt"), "should not be visible\n");
      git("add", "-A"); git("commit", "-qm", "later");
      const testPatch = [
        "diff --git a/check.js b/check.js", "new file mode 100644", "--- /dev/null", "+++ b/check.js", "@@ -0,0 +1 @@",
        "+process.exit(require('./lib.js')(2, 3) === 5 ? 0 : 1);", ""
      ].join("\n");
      const task = makeTask({ repo, commit: base, testPatch, checks: { fail_to_pass: [{ id: "add", command: "node check.js" }] } });
      const agent = new FnAgent((_t, { workdir }) => {
        assert.equal(existsSync(join(workdir, "later.txt")), false, "must be at pinned commit");
        assert.equal(existsSync(join(workdir, "check.js")), false, "test patch must be hidden from the agent");
        writeFileSync(join(workdir, "lib.js"), "module.exports = (a, b) => a + b;\n");
        return noop();
      });
      const run = await new TaskRunner().run(task, agent);
      assert.equal(run.status, "pass");
      assert.deepEqual(run.patch.filesChanged, ["lib.js"], "test patch must not appear in model_patch");
      assert.equal(run.provenance.repo.pinnedCommit, base);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── 10/11. Registry-based agent selection, malformed adapters ───────────────
describe("registry-based CLI agent selection", () => {
  it("every documented agent id resolves through the shared registry", () => {
    const reg = new AgentRegistry();
    for (const id of ["mock", "upstage", "solar", "solar-pro2", "claude", "claude-code", "aider", "opencode"]) {
      assert.ok(typeof reg.resolve(id).run === "function", id);
    }
  });

  it("run's resolveAgent uses the registry (mock ok; custom agents resolvable)", () => {
    assert.equal(resolveAgent("mock").id, "mock");
    const reg = new AgentRegistry();
    reg.register(["custom-x"], () => new FnAgent(noop, "custom-x"));
    assert.equal(resolveAgent("custom-x", {}, reg).id, "custom-x");
  });

  it("unknown or unavailable agents produce clear errors", () => {
    assert.throws(() => resolveAgent("nope"), /Unknown agent: "nope"\. Available: .*mock/);
    const reg = new AgentRegistry();
    reg.register(["offline"], () => { const a = new FnAgent(noop, "offline"); a.isAvailable = () => false; return a; });
    assert.throws(() => resolveAgent("offline", {}, reg), /not available/);
  });

  it("solar-pro2 alias pins that model; upstage alone uses the CLI default", () => {
    assert.equal(new AgentRegistry().resolve("solar-pro2")._model, "solar-pro2");
    assert.equal(new AgentRegistry().resolve("upstage", { model: "solar-pro3" }).id, "upstage-solar-pro3");
    assert.equal(new UpstageAgent().id, "upstage");
  });

  it("malformed adapter from a factory is rejected at resolve time", () => {
    const reg = new AgentRegistry();
    reg.register(["broken"], () => ({}));
    assert.throws(() => reg.resolve("broken"), /malformed/);
    assert.throws(() => reg.resolve(""), /non-empty/);
  });

  it("adapter returning garbage or throwing → status error (not fail, not pass)", async () => {
    const t = makeTask({ checks: FLAKY_CHECKS });
    const garbage = await new TaskRunner().run(t, new FnAgent(() => "lol"));
    assert.equal(garbage.status, "error");
    assert.equal(garbage.outcome.reason, "agent_adapter_error");
    assert.equal(garbage.failure.dimension, "infrastructure");
    const thrower = await new TaskRunner().run(t, new FnAgent(() => { throw new Error("API key invalid"); }));
    assert.equal(thrower.status, "error");
    assert.match(thrower.outcome.detail, /API key invalid/);
    await assert.rejects(() => new TaskRunner().run(t, {}), /Invalid agent adapter/);
  });
});

// ── 12. Usage / cost with missing provider metadata ─────────────────────────
describe("usage and cost are unknown, not zero, when not reported", () => {
  it("adapter without usage → null tokens and cost; composite skips cost", async () => {
    const run = await new TaskRunner().run(makeTask({ checks: FLAKY_CHECKS }), new FnAgent(() => ({ ok: true, events: [] })));
    assert.equal(run.metrics.totalTokens, null);
    assert.equal(run.metrics.estimatedCostUsd, null);
    assert.equal(run.metrics.turns, null);
    assert.equal(run.metrics.toolCalls, null);
    assert.equal(run.evaluation.breakdown.costScore, null);
    assert.equal(run.provenance.model, null);
  });

  it("cost is null for unknown models and for missing usage; 0 only for zero usage", () => {
    assert.equal(new CostTracker(1, "some-new-model").estimate({ promptTokens: 1000, completionTokens: 10 }), null);
    assert.equal(new CostTracker(1, "solar-pro2").estimate(null), null);
    assert.equal(new CostTracker(1, "solar-pro2").estimate({ promptTokens: 0, completionTokens: 0 }), 0);
    assert.ok(new CostTracker(1, "solar-pro2").estimate({ promptTokens: 1_000_000, completionTokens: 0 }) > 0);
  });

  it("extractUsage sums every model call and returns null when none reported", () => {
    assert.equal(extractUsage([{ type: "tool_start" }]), null);
    const u = extractUsage([
      { type: "token_usage", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
      { type: "token_usage", usage: { prompt_tokens: 5, completion_tokens: 1 } }
    ]);
    assert.deepEqual(u, { promptTokens: 15, completionTokens: 3, totalTokens: 18, modelCalls: 2 });
  });
});

// ── pass@k vs pass^k ─────────────────────────────────────────────────────────
describe("pass@k vs pass^k", () => {
  const runs = [{ status: "pass" }, { status: "fail" }, { status: "pass" }, { status: "fail" }];
  it("differ as expected", () => {
    assert.equal(passAtK(runs, 2), 1 - (2 / 4) * (1 / 3));
    assert.equal(passHatK(runs, 2), (2 / 4) * (1 / 3));
    assert.equal(passHatK([{ status: "pass" }, { status: "pass" }], 2), 1);
  });
  it("error/incomplete attempts are excluded and make metrics unknown if too few remain", () => {
    const s = summarizeAttempts([{ status: "pass" }, { status: "error" }, { status: "incomplete" }], 3);
    assert.equal(s.scorable, 1);
    assert.equal(s.errored, 1);
    assert.equal(s.incomplete, 1);
    assert.equal(s.passAtK, null);
    assert.equal(s.passHatK, null);
    assert.equal(passAtK([{ ok: true, status: "fail" }], 1), 0, "ok:true alone is not a pass");
  });
});

// ── Reproducibility record ───────────────────────────────────────────────────
describe("run record reproducibility", () => {
  it("records provenance and sandbox config", async () => {
    const run = await new TaskRunner().run(makeTask({ checks: FLAKY_CHECKS }), new MockAgent());
    assert.ok(run.provenance.harness.node);
    assert.match(run.provenance.task.specSha256, /^[0-9a-f]{64}$/);
    assert.ok(run.provenance.repo.initialCommit);
    assert.equal(run.provenance.seed, null);
    assert.equal(run.sandbox.type, "native");
    assert.equal(typeof run.metrics.agentDurationMs, "number");
  });

  it("run ids do not collide within the same second, and writes never overwrite", async () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeRunId("t", "a")));
    assert.equal(ids.size, 200);
    const dir = tmp("wx");
    try {
      await writeReport({ id: "same" }, dir);
      await assert.rejects(() => writeReport({ id: "same" }, dir), /EEXIST/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("host secrets are redacted from persisted records", () => {
    const env = { UPSTAGE_API_KEY: "up_sk_abcdef123456", HOME: "/home/x" };
    const out = redactSecrets(JSON.stringify({ log: "key=up_sk_abcdef123456 home=/home/x" }), env);
    assert.ok(!out.includes("up_sk_abcdef123456"));
    assert.ok(out.includes("[REDACTED:UPSTAGE_API_KEY]"));
    assert.ok(out.includes("/home/x"));
  });
});

// ── SWE-bench importer ───────────────────────────────────────────────────────
describe("SWE-bench importer", () => {
  const inst = {
    instance_id: "astropy__astropy-12907",
    repo: "astropy/astropy",
    base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    environment_setup_commit: "298ccb478e6bf092953bca67a3d29dc6c35f6752",
    problem_statement: "separability_matrix is wrong for nested models",
    test_patch: "diff --git a/x b/x\n",
    // Official dataset encodes these as JSON strings
    FAIL_TO_PASS: "[\"astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]\"]",
    PASS_TO_PASS: "[\"astropy/modeling/tests/test_separable.py::test_coord_matrix\"]",
    version: "4.3"
  };

  it("parses string-encoded test lists, keeps commit + test patch, marks repo as remote", () => {
    const dir = tmp("swe");
    try {
      const f = join(dir, "d.jsonl");
      writeFileSync(f, JSON.stringify(inst) + "\n");
      const [t] = loadSwebenchFile(f);
      assert.equal(t.checks.fail_to_pass.length, 1);
      assert.equal(t.checks.pass_to_pass.length, 1);
      assert.match(t.checks.fail_to_pass[0].command, /test_separable\[compound_model6-result6\]/);
      assert.equal(t.repo, "github:astropy/astropy");
      assert.equal(t.commit, inst.base_commit);
      assert.equal(t.testPatch, inst.test_patch);
      assert.equal(t._meta.officialEvalCompatible, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("instances with no FAIL_TO_PASS are reported, not imported as check-less tasks", () => {
    const dir = tmp("swe2");
    try {
      const f = join(dir, "d.jsonl");
      writeFileSync(f, JSON.stringify({ ...inst, FAIL_TO_PASS: "[]" }) + "\n");
      const errors = [];
      assert.equal(loadSwebenchFile(f, { onError: (e) => errors.push(e) }).length, 0);
      assert.match(errors[0].message, /FAIL_TO_PASS is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runner refuses a GitHub identifier instead of treating it as a local path", async () => {
    await assert.rejects(
      () => new TaskRunner().run(makeTask({ repo: "github:astropy/astropy", checks: FLAKY_CHECKS }), new MockAgent()),
      /remote identifier, not a local checkout/
    );
    await assert.rejects(
      () => new TaskRunner().run(makeTask({ repo: resolve(tmpdir(), "no-such-owner-h11/no-such-repo"), checks: FLAKY_CHECKS }), new MockAgent()),
      /not found locally/
    );
  });

  it("task with pinned commit on a non-git repo fails clearly", async () => {
    const dir = tmp("nogit");
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.txt"), "a");
      await assert.rejects(() => new TaskRunner().run(makeTask({ repo: dir, commit: "abc123", checks: FLAKY_CHECKS }), new MockAgent()), /not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
