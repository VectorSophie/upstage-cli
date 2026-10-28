// Trace-aware evaluators.
//
// A shell check (checks.mjs) can only inspect the final workspace: it proves
// what the files contain, never HOW they got there. That is insufficient for a
// tool-result-continuation task, where the whole point is that the agent must
// (1) actually invoke a tool and (2) use the value that tool returned — a
// correct final file alone does not prove either.
//
// These evaluators run in the trusted harness process (not inside the sandbox,
// not from agent-editable fixture code) and read two channels the agent cannot
// forge: the harness-recorded tool-call trace, and a pinned hash of the
// generator source. They are referenced by NAME from a task's `checks` (never a
// path to fixture code), so a task file can never make the harness execute
// untrusted JavaScript.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

function checkResult(check, passed, detail) {
  return {
    id: check.id,
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    infraError: null,
    durationMs: 0,
    stdout: passed ? detail : "",
    stderr: passed ? "" : detail,
    weight: check.weight ?? 1.0,
    required: check.required !== false,
    detail
  };
}

function infraResult(check, detail) {
  return {
    id: check.id,
    passed: false,
    exitCode: null,
    timedOut: false,
    infraError: detail,
    durationMs: 0,
    stdout: "",
    stderr: detail,
    weight: check.weight ?? 1.0,
    required: check.required !== false,
    detail
  };
}

function argCommand(args) {
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return args.command;
  if (typeof args.cmd === "string") return args.cmd;
  if (Array.isArray(args.command)) return args.command.join(" ");
  return "";
}

function resultString(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try { return JSON.stringify(result); } catch { return String(result); }
}

function extractTokens(str, re) {
  const out = [];
  if (typeof str !== "string") return out;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(str)) !== null) {
    out.push(m[0]);
    if (m.index === g.lastIndex) g.lastIndex += 1; // zero-width guard
  }
  return out;
}

function hashFile(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * tool-result-continuation — proves the agent ran a specific generator command
 * and wrote the value that command actually emitted.
 *
 * config:
 *   command         substring identifying the challenge command (default "challenge.mjs")
 *   tools           tool names that count as an execution (default ["run_shell","run"])
 *   outputFile      file the agent must write (default "out.txt")
 *   tokenPattern    regex source for the token (default "T3-[0-9a-f]{32}")
 *   generatorFile   generator source file to pin (optional but recommended)
 *   generatorSha256 expected sha256 of generatorFile (held in the trusted task,
 *                   not in the agent workspace — forging the generator is rejected)
 *
 * Passes iff ALL hold:
 *   1. a successful `tools` call ran `command` and its RECORDED result contained
 *      a token matching tokenPattern  → the required tool call really happened
 *      and returned a valid result (not just present in the final files);
 *   2. the generator file is byte-identical to its pinned hash  → the agent did
 *      not rewrite the generator to emit a value of its choosing;
 *   3. `outputFile` equals one of the tokens the generator actually emitted in
 *      the trace  → the agent consumed and used the tool result, not an
 *      arbitrary / hardcoded / guessed value.
 */
export function toolResultContinuation(check, ctx = {}) {
  const cfg = check.config || {};
  const cmdNeedle = cfg.command || "challenge.mjs";
  const execTools = new Set(cfg.tools || ["run_shell", "run"]);
  const outputFile = cfg.outputFile || "out.txt";
  let tokenRe;
  try {
    tokenRe = new RegExp(cfg.tokenPattern || "T3-[0-9a-f]{32}");
  } catch (err) {
    return infraResult(check, `invalid tokenPattern: ${err.message}`);
  }

  const workdir = ctx.workdir;
  if (!workdir) return infraResult(check, "evaluator missing workdir context");
  const trace = Array.isArray(ctx.trace) ? ctx.trace : [];

  // 1) the challenge command actually executed and returned a token
  const execCalls = trace.filter(
    (tc) => tc && execTools.has(tc.tool) && tc.ok === true && argCommand(tc.args).includes(cmdNeedle)
  );
  if (execCalls.length === 0) {
    return checkResult(
      check,
      false,
      `no successful ${[...execTools].join("/")} call executed '${cmdNeedle}' — tool-result continuation not demonstrated (the output file alone does not prove the tool ran)`
    );
  }
  const emitted = new Set();
  for (const tc of execCalls) {
    for (const t of extractTokens(resultString(tc.result), tokenRe)) emitted.add(t);
  }
  if (emitted.size === 0) {
    return checkResult(
      check,
      false,
      `'${cmdNeedle}' ran but its recorded result carried no token matching ${tokenRe} — the tool result was not a valid challenge response`
    );
  }

  // 2) the generator was not tampered with (trusted authority = pinned sha)
  if (cfg.generatorFile && cfg.generatorSha256) {
    const gp = join(workdir, cfg.generatorFile);
    if (!existsSync(gp)) {
      return checkResult(check, false, `generator '${cfg.generatorFile}' is missing from the workspace`);
    }
    const actual = hashFile(gp);
    if (actual !== cfg.generatorSha256) {
      return checkResult(
        check,
        false,
        `generator '${cfg.generatorFile}' was modified (sha ${actual.slice(0, 12)}… ≠ pinned ${cfg.generatorSha256.slice(0, 12)}…) — a self-emitted / forged token is not accepted`
      );
    }
  }

  // 3) the agent used the emitted value
  const op = join(workdir, outputFile);
  if (!existsSync(op)) {
    return checkResult(check, false, `'${outputFile}' was not created`);
  }
  let written;
  try {
    written = readFileSync(op, "utf8").trim();
  } catch (err) {
    return infraResult(check, `could not read '${outputFile}': ${err.message}`);
  }
  if (!emitted.has(written)) {
    return checkResult(
      check,
      false,
      `'${outputFile}' (${JSON.stringify(written.slice(0, 48))}) does not match any token the challenge actually emitted — the result was ignored, hardcoded, or guessed`
    );
  }
  return checkResult(
    check,
    true,
    `challenge '${cmdNeedle}' executed ${execCalls.length}×, generator intact, '${outputFile}' matches the emitted token`
  );
}

const REGISTRY = {
  "tool-result-continuation": toolResultContinuation
};

export function getEvaluator(name) {
  return REGISTRY[name] || null;
}

/** Run a check that names a builtin evaluator (vs a shell command). */
export function runEvaluatorCheck(check, ctx = {}) {
  const fn = getEvaluator(check.evaluator);
  if (!fn) {
    // Unknown evaluator is an infrastructure error (→ status=error), never a
    // silent pass: an unrecognised evaluator must not let a task look solved.
    return infraResult(check, `unknown evaluator '${check.evaluator}'`);
  }
  try {
    return fn(check, ctx);
  } catch (err) {
    return infraResult(check, `evaluator '${check.evaluator}' threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
