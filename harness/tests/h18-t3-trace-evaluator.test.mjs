// Adversarial regression tests for the HARDENED T3 tool-result-continuation
// evaluator. Two layers:
//   A. Unit — the evaluator against synthetic traces + workspaces, covering the
//      command-identity, stdout-only, and generator-integrity rules precisely.
//   B. End-to-end — the REAL TaskRunner + LocalModelAgent + real agent loop +
//      native sandbox actually executing `node challenge.mjs`; only the model
//      HTTP endpoint is stubbed. The stub reads the live token from the request
//      body (the tool-result message) to simulate genuine result consumption.
//
// The hardened evaluator defeats: filename-in-args spoofing, shell-comment
// spoofing, alternate command printing a fabricated token, token-only-in-stderr,
// failed/timed-out executions, and (via the immutableGenerator config used by
// T3-v3) modify/restore of the generator. See docs/T3_TRACE_EVALUATION.md.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { toolResultContinuation, runEvaluatorCheck } from "../src/evaluation/evaluators.mjs";
import { loadTask } from "../src/task/loader.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { defaultRegistry } from "../src/agent/registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../fixtures/tool-continuation-v2");
const GEN_SRC = readFileSync(join(FIXTURE, "challenge.mjs"));
const GEN_SHA = createHash("sha256").update(GEN_SRC).digest("hex");
const TOKEN_RE = "T3-[0-9a-f]{32}";
const TOK = (hex) => `T3-${hex}`;
const HEX32 = "0123456789abcdef0123456789abcdef";

// Native (legacy) config: exact command identity + stdout-only + best-effort hash.
const CHECK = {
  id: "t3",
  evaluator: "tool-result-continuation",
  required: true,
  config: {
    command: "node challenge.mjs",
    tools: ["run_shell", "run"],
    outputFile: "out.txt",
    tokenPattern: TOKEN_RE,
    generatorFile: "challenge.mjs",
    generatorSha256: GEN_SHA
  }
};
// Immutable (Docker) config: command identity on the read-only mounted path.
const CHECK_IMMUTABLE = {
  id: "t3",
  evaluator: "tool-result-continuation",
  required: true,
  config: { command: "node /opt/t3/challenge.mjs", outputFile: "out.txt", tokenPattern: TOKEN_RE, immutableGenerator: true }
};

// A run_shell trace entry the way AuditLog records it: a stringified `result`
// (display) AND a structured `resultData` (what the hardened evaluator reads).
function shellCall(command, stdout, { ok = true, stderr = "", code = 0, timedOut = false, truncated = false } = {}) {
  return {
    tool: "run_shell",
    ok: true, // registry-level: the tool itself did not throw
    args: { command },
    result: JSON.stringify({ ok, code, stdout, stderr, truncated, timedOut }),
    resultData: { ok, code, stdout, stderr, timedOut, truncated }
  };
}
function readCall(path, content) {
  return { tool: "read_file", ok: true, args: { path }, result: JSON.stringify({ content }) };
}

function makeWorkdir({ out, tamperGen = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h18-"));
  writeFileSync(join(dir, "challenge.mjs"), tamperGen ? 'process.stdout.write("T3-"+"a".repeat(32)+"\\n");\n' : GEN_SRC);
  if (out !== undefined) writeFileSync(join(dir, "out.txt"), out);
  return dir;
}
const dirs = [];
function wd(opts) { const d = makeWorkdir(opts); dirs.push(d); return d; }
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const ev = (check, out, trace) => toolResultContinuation(check, { workdir: wd(typeof out === "object" ? out : { out }), trace });

describe("T3 hardened evaluator — unit (adversarial)", () => {
  it("GENUINE execution and correct output → PASS", () => {
    const t = TOK("abcdef12".repeat(4));
    const r = ev(CHECK, `${t}\n`, [shellCall("node challenge.mjs", `${t}\n`)]);
    assert.equal(r.passed, true, r.detail);
  });

  it("source inspection only (read_file, no exec) → FAIL", () => {
    const r = ev(CHECK, TOK(HEX32), [readCall("challenge.mjs", String(GEN_SRC))]);
    assert.equal(r.passed, false);
    assert.match(r.detail, /ran exactly/);
  });

  it("hardcoded legacy token, no execution → FAIL", () => {
    const r = ev(CHECK, "TOKEN-7F3A9C", []);
    assert.equal(r.passed, false);
  });

  it("arbitrary token without executing the generator → FAIL", () => {
    const r = ev(CHECK, TOK("2".repeat(32)), []);
    assert.equal(r.passed, false);
  });

  it("Bypass A: command merely MENTIONS the filename but does not execute it → FAIL", () => {
    const t = TOK("a".repeat(32));
    const r = ev(CHECK, t, [shellCall(`echo ${t} challenge.mjs`, `${t}\n`)]);
    assert.equal(r.passed, false);
    assert.match(r.detail, /ran exactly|mentioning/);
  });

  it("Bypass A2: shell-comment spoofing (`… # challenge.mjs`) → FAIL", () => {
    const t = TOK("b".repeat(32));
    const r = ev(CHECK, t, [shellCall(`printf '${t}' # challenge.mjs`, `${t}\n`)]);
    assert.equal(r.passed, false);
  });

  it("Bypass A3: chained/aliased command printing a fabricated token → FAIL", () => {
    const t = TOK("c".repeat(32));
    // `;` is a blocked metacharacter → not a clean single invocation
    const r = ev(CHECK, t, [shellCall(`node challenge.mjs; echo ${t}`, `${t}\n`)]);
    assert.equal(r.passed, false);
  });

  it("Bypass C: token only in STDERR (stdout empty) → FAIL", () => {
    const t = TOK("d".repeat(32));
    const r = ev(CHECK, t, [shellCall("node challenge.mjs", "", { stderr: `${t}\n` })]);
    assert.equal(r.passed, false);
    assert.match(r.detail, /stdout carried no token/);
  });

  it("Bypass C2: token present but execution FAILED (non-zero exit) → FAIL", () => {
    const t = TOK("e".repeat(32));
    const r = ev(CHECK, t, [shellCall("node challenge.mjs", `${t}\n`, { ok: false, code: 1 })]);
    assert.equal(r.passed, false);
    assert.match(r.detail, /no execution succeeded cleanly/);
  });

  it("Bypass C3: token present but execution TIMED OUT → FAIL", () => {
    const t = TOK("f".repeat(32));
    const r = ev(CHECK, t, [shellCall("node challenge.mjs", `${t}\n`, { timedOut: true })]);
    assert.equal(r.passed, false);
  });

  it("correct execution but WRONG final output → FAIL", () => {
    const emitted = TOK("1".repeat(32));
    const r = ev(CHECK, TOK("9".repeat(32)), [shellCall("node challenge.mjs", `${emitted}\n`)]);
    assert.equal(r.passed, false);
    assert.match(r.detail, /does not match/);
  });

  it("running the generator but never writing out.txt → FAIL", () => {
    const t = TOK("6".repeat(32));
    const r = toolResultContinuation(CHECK, { workdir: wd({}), trace: [shellCall("node challenge.mjs", `${t}\n`)] });
    assert.equal(r.passed, false);
    assert.match(r.detail, /was not created/);
  });

  it("immutableGenerator: running the WORKSPACE path (not the mounted one) → FAIL", () => {
    const t = TOK("7".repeat(32));
    const r = ev(CHECK_IMMUTABLE, t, [shellCall("node challenge.mjs", `${t}\n`)]);
    assert.equal(r.passed, false);
    assert.match(r.detail, /ran exactly `node \/opt\/t3\/challenge.mjs`/);
  });

  it("immutableGenerator: genuine execution of the mounted path → PASS", () => {
    const t = TOK("8".repeat(32));
    const r = ev(CHECK_IMMUTABLE, `${t}\n`, [shellCall("node /opt/t3/challenge.mjs", `${t}\n`)]);
    assert.equal(r.passed, true, r.detail);
  });

  it("legacy native hash still rejects a PERSISTENTLY modified generator → FAIL", () => {
    const t = TOK("a".repeat(32));
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: t, tamperGen: true }), trace: [shellCall("node challenge.mjs", `${t}\n`)] });
    assert.equal(r.passed, false);
    assert.match(r.detail, /was modified/);
  });

  it("multiple genuine executions: out.txt matching ANY emitted stdout token → PASS", () => {
    const a = TOK("aa".repeat(16));
    const b = TOK("bb".repeat(16));
    const r = ev(CHECK, a, [shellCall("node challenge.mjs", `${a}\n`), shellCall("node challenge.mjs", `${b}\n`)]);
    assert.equal(r.passed, true, r.detail);
  });

  it("unknown evaluator name is an infrastructure error, not a silent pass", () => {
    const r = runEvaluatorCheck({ id: "x", evaluator: "does-not-exist" }, { workdir: wd({ out: "x" }), trace: [] });
    assert.ok(r.infraError);
    assert.equal(r.passed, false);
  });

  it("empty trace (baseline, no agent) → FAIL", () => {
    const r = toolResultContinuation(CHECK, { workdir: wd({}), trace: [] });
    assert.equal(r.passed, false);
  });
});

// ── Layer B: real pipeline, stubbed model endpoint (native) ─────────────────
const TASK_PATH = resolve(HERE, "../tasks/local/pilot-t3-tool-continuation-v2.yaml");
const realFetch = globalThis.fetch;
let callCount = 0;
function stubModel(handler) {
  callCount = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/chat/completions")) { callCount += 1; return handler(callCount, opts); }
    return realFetch(url, opts);
  };
}
function json(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } }); }
function toolCall(name, args) {
  return json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${callCount}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
}
function stop(text) { return json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }); }
function tokenFromBody(opts) {
  const body = typeof opts?.body === "string" ? opts.body : "";
  const m = body.match(/T3-[0-9a-f]{32}/g);
  return m ? m[m.length - 1] : null;
}

let savedCritic;
before(() => { savedCritic = process.env.UPSTAGE_CRITIC_DISABLED; process.env.UPSTAGE_CRITIC_DISABLED = "true"; });
after(() => { if (savedCritic === undefined) delete process.env.UPSTAGE_CRITIC_DISABLED; else process.env.UPSTAGE_CRITIC_DISABLED = savedCritic; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("T3 hardened evaluator — real harness pipeline (live node exec, stubbed model)", () => {
  it("baseline is valid: task loads; acceptance is the trace evaluator; no answer leaks", () => {
    const task = loadTask(TASK_PATH);
    assert.equal(task.version, 2);
    assert.equal(task.checks.custom[0].evaluator, "tool-result-continuation");
    assert.equal(task.checks.custom[0].config.command, "node challenge.mjs");
    assert.ok(!(task.checks.fail_to_pass || []).some((c) => /T3-|TOKEN-/.test(c.command || "")));
  });

  it("agent that RUNS `node challenge.mjs` and writes the emitted stdout token → PASS", async () => {
    stubModel((n, opts) => {
      if (n === 1) return toolCall("run_shell", { command: "node challenge.mjs" });
      if (n === 2) { const tok = tokenFromBody(opts); assert.ok(tok, "stub should see the live token"); return toolCall("write_file", { path: "out.txt", content: tok }); }
      return stop("Done.");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("kanana"));
    assert.equal(result.status, "pass", `expected pass, got ${result.status} (${result.outcome?.detail})`);
    assert.ok(result.patch.filesChanged.includes("out.txt"));
    assert.ok(!result.patch.filesChanged.includes("challenge.mjs"));
  });

  it("agent that writes a hardcoded/old token WITHOUT running the generator → FAIL", async () => {
    stubModel((n) => (n === 1 ? toolCall("write_file", { path: "out.txt", content: "TOKEN-7F3A9C" }) : stop("done")));
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("ax"));
    assert.equal(result.status, "fail", `expected fail, got ${result.status}`);
  });

  it("Bypass A live: `echo <token> challenge.mjs` (filename in args, no execution) → FAIL", async () => {
    stubModel((n) => {
      if (n === 1) return toolCall("run_shell", { command: `echo ${"T3-" + "a".repeat(32)} challenge.mjs` });
      if (n === 2) return toolCall("write_file", { path: "out.txt", content: "T3-" + "a".repeat(32) });
      return stop("done");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("exaone"));
    assert.equal(result.status, "fail", `expected fail, got ${result.status}`);
  });

  it("agent that runs the generator but writes an arbitrary value → FAIL", async () => {
    stubModel((n) => {
      if (n === 1) return toolCall("run_shell", { command: "node challenge.mjs" });
      if (n === 2) return toolCall("write_file", { path: "out.txt", content: `T3-${"f".repeat(32)}` });
      return stop("done");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("exaone"));
    assert.equal(result.status, "fail", `expected fail, got ${result.status}`);
  });
});
