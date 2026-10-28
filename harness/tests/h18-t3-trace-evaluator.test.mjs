// Adversarial regression tests for the rigorous T3 tool-result-continuation
// evaluator. Two layers:
//   A. Unit — the evaluator against synthetic traces + workspaces, covering
//      every adversarial requirement precisely and deterministically.
//   B. End-to-end — the REAL TaskRunner + LocalModelAgent + real agent loop +
//      native sandbox actually executing `node challenge.mjs`; only the model
//      HTTP endpoint is stubbed. The stub reads the live token from the request
//      body (the tool-result message) to simulate genuine result consumption.
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

const CHECK = {
  id: "t3",
  evaluator: "tool-result-continuation",
  required: true,
  config: {
    command: "challenge.mjs",
    tools: ["run_shell", "run"],
    outputFile: "out.txt",
    tokenPattern: TOKEN_RE,
    generatorFile: "challenge.mjs",
    generatorSha256: GEN_SHA
  }
};

// Build a run_shell trace entry the way AuditLog records it: result is the
// stringified tool data (what the harness captured), args carry the command.
function shellCall(command, stdout, ok = true) {
  return { tool: "run_shell", ok, args: { command }, result: JSON.stringify({ ok, code: ok ? 0 : 1, stdout, stderr: "", truncated: false, timedOut: false }) };
}

function makeWorkdir({ out, tamperGen = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h18-"));
  if (tamperGen) {
    writeFileSync(join(dir, "challenge.mjs"), 'process.stdout.write("T3-" + "a".repeat(32) + "\\n");\n');
  } else {
    writeFileSync(join(dir, "challenge.mjs"), GEN_SRC);
  }
  if (out !== undefined) writeFileSync(join(dir, "out.txt"), out);
  return dir;
}

const dirs = [];
function wd(opts) { const d = makeWorkdir(opts); dirs.push(d); return d; }
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

describe("T3 evaluator — unit (adversarial)", () => {
  it("source inspection cannot pass: reading challenge.mjs reveals no token, so no exec call → fail", () => {
    // Agent only read the file (no run_shell), then wrote a plausible guess.
    const trace = [{ tool: "read_file", ok: true, args: { path: "challenge.mjs" }, result: JSON.stringify({ content: String(GEN_SRC) }) }];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: TOK(HEX32) }), trace });
    assert.equal(r.passed, false);
    assert.match(r.detail, /no successful.*executed/i);
  });

  it("hardcoding the OLD leaked token (TOKEN-7F3A9C) fails", () => {
    const trace = [shellCall("node challenge.mjs", `${TOK("deadbeef".repeat(4))}\n`)];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: "TOKEN-7F3A9C" }), trace });
    assert.equal(r.passed, false);
    assert.match(r.detail, /does not match any token/i);
  });

  it("writing an arbitrary value (even well-formed) that was never emitted fails", () => {
    const emitted = TOK("1".repeat(32));
    const arbitrary = TOK("2".repeat(32));
    const trace = [shellCall("node challenge.mjs", `${emitted}\n`)];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: arbitrary }), trace });
    assert.equal(r.passed, false);
    assert.match(r.detail, /does not match any token/i);
  });

  it("executing the challenge AND writing its emitted token succeeds", () => {
    const emitted = TOK("abcdef12".repeat(4));
    const trace = [shellCall("node challenge.mjs", `${emitted}\n`)];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: `${emitted}\n` }), trace });
    assert.equal(r.passed, true, r.detail);
  });

  it("executing the challenge but IGNORING its output (writing something else) fails", () => {
    const emitted = TOK("5".repeat(32));
    const trace = [shellCall("node challenge.mjs", `${emitted}\n`)];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: "whatever the model felt like" }), trace });
    assert.equal(r.passed, false);
    assert.match(r.detail, /ignored|does not match/i);
  });

  it("running the challenge but never writing out.txt fails", () => {
    const emitted = TOK("6".repeat(32));
    const trace = [shellCall("node challenge.mjs", `${emitted}\n`)];
    const r = toolResultContinuation(CHECK, { workdir: wd({}), trace }); // no out.txt
    assert.equal(r.passed, false);
    assert.match(r.detail, /was not created/i);
  });

  it("modifying the generator to emit a chosen token cannot forge a pass (sha mismatch)", () => {
    // Agent rewrote challenge.mjs to emit T3-aaaa…, ran it, wrote that value.
    const forged = TOK("a".repeat(32));
    const trace = [shellCall("node challenge.mjs", `${forged}\n`)];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: forged, tamperGen: true }), trace });
    assert.equal(r.passed, false);
    assert.match(r.detail, /was modified|forged/i);
  });

  it("a failed challenge execution (ok:false) does not count as a valid tool result", () => {
    const trace = [shellCall("node challenge.mjs", "", false)];
    const r = toolResultContinuation(CHECK, { workdir: wd({ out: TOK(HEX32) }), trace });
    assert.equal(r.passed, false);
    assert.match(r.detail, /no successful|not demonstrated/i);
  });

  it("independent attempts get distinct tokens, and each is verified against its OWN run", () => {
    const a = TOK("aa".repeat(16));
    const b = TOK("bb".repeat(16));
    assert.notEqual(a, b);
    const rA = toolResultContinuation(CHECK, { workdir: wd({ out: a }), trace: [shellCall("node challenge.mjs", `${a}\n`)] });
    const rB = toolResultContinuation(CHECK, { workdir: wd({ out: b }), trace: [shellCall("node challenge.mjs", `${b}\n`)] });
    assert.equal(rA.passed, true, rA.detail);
    assert.equal(rB.passed, true, rB.detail);
    // cross-use fails: attempt A's output against attempt B's run
    const cross = toolResultContinuation(CHECK, { workdir: wd({ out: a }), trace: [shellCall("node challenge.mjs", `${b}\n`)] });
    assert.equal(cross.passed, false);
  });

  it("an unknown evaluator name is an infrastructure error, never a silent pass", () => {
    const r = runEvaluatorCheck({ id: "x", evaluator: "does-not-exist" }, { workdir: wd({ out: "x" }), trace: [] });
    assert.ok(r.infraError, "must flag infraError");
    assert.equal(r.passed, false);
  });

  it("empty trace (baseline, no agent) fails — acceptance check correctly fails on pristine repo", () => {
    const r = toolResultContinuation(CHECK, { workdir: wd({}), trace: [] });
    assert.equal(r.passed, false);
  });
});

// ── Layer B: real pipeline, stubbed model endpoint ──────────────────────────
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
  return m ? m[m.length - 1] : null; // the most recent token the tool returned
}

let savedCritic;
before(() => { savedCritic = process.env.UPSTAGE_CRITIC_DISABLED; process.env.UPSTAGE_CRITIC_DISABLED = "true"; });
after(() => { if (savedCritic === undefined) delete process.env.UPSTAGE_CRITIC_DISABLED; else process.env.UPSTAGE_CRITIC_DISABLED = savedCritic; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("T3 evaluator — real harness pipeline (live node exec, stubbed model)", () => {
  it("baseline is valid: task loads and the acceptance check is the trace evaluator", () => {
    const task = loadTask(TASK_PATH);
    assert.equal(task.version, 2);
    assert.equal(task.checks.custom[0].evaluator, "tool-result-continuation");
    assert.equal(task.checks.custom[0].config.generatorSha256, GEN_SHA);
    // no fail_to_pass command leaks the answer
    assert.ok(!(task.checks.fail_to_pass || []).some((c) => /T3-|TOKEN-/.test(c.command || "")));
  });

  it("agent that RUNS challenge.mjs and writes the emitted token → PASS", async () => {
    stubModel((n, opts) => {
      if (n === 1) return toolCall("run_shell", { command: "node challenge.mjs" });
      if (n === 2) {
        const tok = tokenFromBody(opts);
        assert.ok(tok, "stub should see the live token in the tool-result message");
        return toolCall("write_file", { path: "out.txt", content: tok });
      }
      return stop("Done.");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("kanana"));
    assert.equal(result.status, "pass", `expected pass, got ${result.status} (${result.outcome?.detail})`);
    assert.equal(result.outcome.reason, "all_required_checks_passed");
    assert.ok(result.patch.filesChanged.includes("out.txt"));
    // challenge.mjs must be untouched
    assert.ok(!result.patch.filesChanged.includes("challenge.mjs"));
  });

  it("agent that writes a hardcoded/old token WITHOUT running the challenge → FAIL", async () => {
    stubModel((n) => (n === 1 ? toolCall("write_file", { path: "out.txt", content: "TOKEN-7F3A9C" }) : stop("done")));
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("ax"));
    assert.equal(result.status, "fail", `expected fail, got ${result.status}`);
    assert.equal(result.outcome.reason, "required_check_failed");
  });

  it("agent that runs the challenge but writes an arbitrary value (ignores output) → FAIL", async () => {
    stubModel((n) => {
      if (n === 1) return toolCall("run_shell", { command: "node challenge.mjs" });
      if (n === 2) return toolCall("write_file", { path: "out.txt", content: `T3-${"f".repeat(32)}` });
      return stop("done");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(TASK_PATH), defaultRegistry.resolve("exaone"));
    assert.equal(result.status, "fail", `expected fail, got ${result.status}`);
  });
});
