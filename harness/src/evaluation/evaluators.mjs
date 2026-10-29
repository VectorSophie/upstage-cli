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

// Shell constructs that must never appear in an authorized generator
// invocation: command chaining / pipes / subshells / backticks (mirrors the
// executor's own block), plus comments and redirects (which a shell would act
// on and which can smuggle a filename or fabricate output).
const META = /[;&|`]|\$\(/;
const UNSAFE = /[#<>\r\n]/;

/**
 * Tokenise a run_shell command the same way the sandbox executor does, and
 * refuse anything that is not a single clean invocation. Returns the argv, or
 * null if the command is unsafe/compound. Identity is then an EXACT argv match,
 * never a substring — `echo T3-… challenge.mjs` and `foo # challenge.mjs` do
 * not tokenise to the expected argv and are rejected.
 */
function tokenizeCommand(command) {
  if (Array.isArray(command)) {
    const argv = command.map(String);
    return argv.some((a) => META.test(a) || UNSAFE.test(a)) ? null : argv;
  }
  if (typeof command !== "string") return null;
  const c = command.trim();
  if (c === "" || META.test(c) || UNSAFE.test(c)) return null;
  return c.split(/\s+/);
}

function argvOf(args) {
  if (!args || typeof args !== "object") return null;
  if (typeof args.command === "string" || Array.isArray(args.command)) return tokenizeCommand(args.command);
  if (typeof args.cmd === "string") return tokenizeCommand(args.cmd);
  return null;
}

function argvEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The stdout of a successful, complete execution — or null. Reads the STRUCTURED
 * result the audit log preserves (`resultData`), so a token in stderr, in the
 * echoed command, or in serialized metadata can never be mistaken for generator
 * output. Fails closed: a failed, timed-out, truncated, or non-zero-exit result,
 * or one without structured stdout, yields null.
 */
function execStdout(tc) {
  const rd = tc && tc.resultData;
  if (!rd || typeof rd.stdout !== "string") return null;
  if (rd.ok !== true) return null;
  if (rd.timedOut === true || rd.truncated === true) return null;
  if (typeof rd.code === "number" && rd.code !== 0) return null;
  return rd.stdout;
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
 * tool-result-continuation (hardened) — proves the agent executed the exact,
 * trusted generator and wrote the value that execution actually emitted.
 *
 * config:
 *   command          EXACT command the agent must run, e.g. "node /opt/t3/challenge.mjs".
 *                    Matched as a tokenised argv (not a substring); compound /
 *                    commented / redirected commands are rejected. (default "node challenge.mjs")
 *   tools            tool names that count as an execution (default ["run_shell","run"])
 *   outputFile       file the agent must write (default "out.txt")
 *   tokenPattern     regex source for the token (default "T3-[0-9a-f]{32}")
 *   immutableGenerator  true ⇒ the generator executes from a read-only location
 *                    the agent cannot modify (e.g. a Docker read-only mount), so
 *                    integrity is structural and no post-hoc file hash is used.
 *   generatorFile/generatorSha256  (legacy, native best-effort) a post-run
 *                    workspace-file hash; documented as NOT execution-time proof.
 *
 * Passes iff ALL hold:
 *   1. a successful, complete `tools` call ran EXACTLY `command` (argv identity,
 *      not substring) — defeats filename-in-args / comment / chaining spoofing;
 *   2. that call's STDOUT (isolated from stderr/metadata; ok + exit 0 + not
 *      timed-out/truncated) contained a token matching tokenPattern — defeats
 *      stderr/echo/metadata spoofing and failed/truncated executions;
 *   3. the generator could not have been forged: under immutableGenerator it is
 *      mounted read-only outside the workspace; otherwise the legacy workspace
 *      hash is checked (weaker, native only);
 *   4. `outputFile` equals one of the tokens a qualifying execution emitted on
 *      stdout — the agent consumed and used the recorded result.
 */
export function toolResultContinuation(check, ctx = {}) {
  const cfg = check.config || {};
  const expectArgv = tokenizeCommand(cfg.command || "node challenge.mjs");
  if (!expectArgv) {
    return infraResult(check, `invalid config.command (must be a single clean invocation): ${JSON.stringify(cfg.command)}`);
  }
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

  // 1) the EXACT trusted command executed (argv identity, not substring)
  const idCalls = trace.filter((tc) => tc && execTools.has(tc.tool) && argvEqual(argvOf(tc.args), expectArgv));
  if (idCalls.length === 0) {
    return checkResult(
      check,
      false,
      `no ${[...execTools].join("/")} call ran exactly \`${expectArgv.join(" ")}\` — a command merely mentioning the generator, or a chained/commented/redirected command, does not count`
    );
  }

  // 2) a successful, complete execution whose STDOUT carried a valid token
  const emitted = new Set();
  let hadValidExec = false;
  for (const tc of idCalls) {
    const stdout = execStdout(tc);
    if (stdout === null) continue; // failed / timed-out / truncated / no structured stdout
    hadValidExec = true;
    for (const t of extractTokens(stdout, tokenRe)) emitted.add(t);
  }
  if (!hadValidExec) {
    return checkResult(check, false, `\`${expectArgv.join(" ")}\` ran but no execution succeeded cleanly with structured stdout (failed, timed out, truncated, or non-zero exit)`);
  }
  if (emitted.size === 0) {
    return checkResult(check, false, `\`${expectArgv.join(" ")}\` ran but its stdout carried no token matching ${tokenRe} (a token in stderr or echoed metadata does not count)`);
  }

  // 3) generator integrity
  if (cfg.immutableGenerator) {
    // Integrity is structural (read-only mount outside the agent-writable
    // workspace); nothing to hash. The command identity above already pins the
    // trusted path, which the agent cannot replace.
  } else if (cfg.generatorFile && cfg.generatorSha256) {
    // Legacy native best-effort: a post-run hash. NOTE: this is NOT proof the
    // file was unmodified at execution time (an agent can modify→run→restore);
    // use immutableGenerator for a real guarantee.
    const gp = join(workdir, cfg.generatorFile);
    if (!existsSync(gp)) {
      return checkResult(check, false, `generator '${cfg.generatorFile}' is missing from the workspace`);
    }
    const actual = hashFile(gp);
    if (actual !== cfg.generatorSha256) {
      return checkResult(check, false, `generator '${cfg.generatorFile}' was modified (sha ${actual.slice(0, 12)}… ≠ pinned ${cfg.generatorSha256.slice(0, 12)}…)`);
    }
  }

  // 4) the agent used a genuinely-emitted value
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
      `'${outputFile}' (${JSON.stringify(written.slice(0, 48))}) does not match any token the trusted execution emitted on stdout — ignored, hardcoded, guessed, or forged`
    );
  }
  return checkResult(
    check,
    true,
    `exact command \`${expectArgv.join(" ")}\` executed, stdout token consumed into '${outputFile}'${cfg.immutableGenerator ? " (read-only generator)" : ""}`
  );
}

// ── tool-result-selection ──────────────────────────────────────────────────
// Like tool-result-continuation, but the agent must INTERPRET structured JSON
// the tool emitted and select the correct value — not copy stdout. The trusted
// evaluator recomputes the correct value from the qualifying execution's own
// stdout (so it is always the dynamic, non-guessable token the run produced),
// using a SAFE, declarative selector (no eval, no agent-supplied code).

/** Walk an object by an explicit key/index path. Returns undefined on any miss. */
function getPath(obj, path) {
  let cur = obj;
  for (const key of path || []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Apply a declarative selector to parsed JSON → the expected value (or null).
 *   find-field {listPath, matchKey, matchValue, valueKey}
 *   max-by     {listPath, valueKey, returnKey}
 *   indirect   {keyPath, mapPath}
 */
export function applySelector(json, sel) {
  if (!sel || typeof sel !== "object") return null;
  if (sel.kind === "find-field") {
    const list = getPath(json, sel.listPath);
    if (!Array.isArray(list)) return null;
    const hit = list.find((it) => it && it[sel.matchKey] === sel.matchValue);
    const v = hit ? hit[sel.valueKey] : undefined;
    return typeof v === "string" ? v : null;
  }
  if (sel.kind === "max-by") {
    const list = getPath(json, sel.listPath);
    if (!Array.isArray(list) || list.length === 0) return null;
    let best = null;
    for (const it of list) {
      if (!it || typeof it[sel.valueKey] !== "number") return null;
      if (best === null || it[sel.valueKey] > best[sel.valueKey]) best = it;
    }
    const v = best ? best[sel.returnKey] : undefined;
    return typeof v === "string" ? v : null;
  }
  if (sel.kind === "indirect") {
    const key = getPath(json, sel.keyPath);
    if (typeof key !== "string") return null;
    const map = getPath(json, sel.mapPath);
    if (!map || typeof map !== "object") return null;
    const v = map[key];
    return typeof v === "string" ? v : null;
  }
  return null;
}

export function toolResultSelection(check, ctx = {}) {
  const cfg = check.config || {};
  const expectArgv = tokenizeCommand(cfg.command || "node gen.mjs");
  if (!expectArgv) return infraResult(check, `invalid config.command: ${JSON.stringify(cfg.command)}`);
  if (!cfg.selector || typeof cfg.selector !== "object") return infraResult(check, "tool-result-selection requires a config.selector");
  const execTools = new Set(cfg.tools || ["run_shell", "run"]);
  const outputFile = cfg.outputFile || "out.txt";
  let tokenRe;
  try { tokenRe = new RegExp(cfg.tokenPattern || "BV1H-[0-9a-f]{32}"); }
  catch (err) { return infraResult(check, `invalid tokenPattern: ${err.message}`); }

  const workdir = ctx.workdir;
  if (!workdir) return infraResult(check, "evaluator missing workdir context");
  const trace = Array.isArray(ctx.trace) ? ctx.trace : [];

  const idCalls = trace.filter((tc) => tc && execTools.has(tc.tool) && argvEqual(argvOf(tc.args), expectArgv));
  if (idCalls.length === 0) {
    return checkResult(check, false, `no ${[...execTools].join("/")} call ran exactly \`${expectArgv.join(" ")}\``);
  }

  // Recompute the correct value from each qualifying run's OWN stdout.
  const expected = new Set();
  let hadValidExec = false;
  let sawJson = false;
  for (const tc of idCalls) {
    const stdout = execStdout(tc);
    if (stdout === null) continue;
    hadValidExec = true;
    let json;
    try { json = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || stdout); }
    catch { continue; }
    sawJson = true;
    const v = applySelector(json, cfg.selector);
    if (typeof v === "string" && tokenRe.test(v)) expected.add(v);
  }
  if (!hadValidExec) return checkResult(check, false, `\`${expectArgv.join(" ")}\` ran but no execution succeeded cleanly with structured stdout`);
  if (!sawJson) return checkResult(check, false, `\`${expectArgv.join(" ")}\` stdout was not valid JSON`);
  if (expected.size === 0) return checkResult(check, false, `selector ${JSON.stringify(cfg.selector)} did not resolve to a token matching ${tokenRe} in the tool output`);

  const op = join(workdir, outputFile);
  if (!existsSync(op)) return checkResult(check, false, `'${outputFile}' was not created`);
  let written;
  try { written = readFileSync(op, "utf8").trim(); }
  catch (err) { return infraResult(check, `could not read '${outputFile}': ${err.message}`); }
  if (!expected.has(written)) {
    return checkResult(check, false, `'${outputFile}' (${JSON.stringify(written.slice(0, 48))}) is not the correctly-selected value from the tool output — wrong field, copied whole output, guessed, or hardcoded`);
  }
  return checkResult(check, true, `exact command \`${expectArgv.join(" ")}\` executed; correctly selected value written to '${outputFile}'`);
}

const REGISTRY = {
  "tool-result-continuation": toolResultContinuation,
  "tool-result-selection": toolResultSelection
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
