// `upstage sessions list/show/resume/export` — Task 12.6 (folded with Task
// 7.13's formatting logic per the release plan's explicit "or folded into
// Task 12.6's sessions.mjs" note) of the 3.2.0 release plan (§6 command
// tree, §7.L export-format design detail).
//
// Four subcommands over the existing session-storage primitives
// (src/runtime/session.mjs — `listSessions`/`loadSession`) and the new
// formatting module (src/runtime/session-export.mjs, Task 7.13):
//
//   - list    — every stored session's metadata (id/updatedAt/workspace)
//   - show    — one session's summary (counts, not a full dump — see below)
//   - resume  — hands off to the EXACT SAME code path a bare
//               `upstage --session <id>` takes today (src/cli/index.mjs's
//               `runClassicCli`), not a reimplementation of it. See the
//               "same code path" comment on `runSessionsResumeCommand` below.
//   - export  — `formatSessionAs{Json,Jsonl,Markdown}` (session-export.mjs),
//               redacting raw write_file/edit_file file bodies by default
//               (§7.L / §8) unless `--include-tool-io` is passed.
//
// `show` deliberately does NOT dump the full raw session (that's what
// `export` is for) — it prints a bounded summary (counts, timestamps,
// workspace), safe to print without `--include-tool-io` gating, mirroring
// the same summary shape session.mjs's own sanitizer already uses when a
// session is embedded inside a runtime event (see `sanitizeValue`'s
// `keyName === "session"` special case).

import { listSessions, loadSession } from "../../runtime/session.mjs";
import {
  formatSessionAsJson,
  formatSessionAsJsonl,
  formatSessionAsMarkdown
} from "../../runtime/session-export.mjs";
import { runClassicCli, parseArgs } from "../index.mjs";

// Exposed purely so tests can assert reference-identity against index.mjs's
// exports (tests/m33-sessions-cli.test.mjs's "same code path" test) — proof
// that `sessions resume` invokes the *exact* same `runClassicCli`/`parseArgs`
// function objects index.mjs's own `--session <id>` handling uses, not a
// reimplementation of them. Production code never reads this; it's the
// default-parameter fallback inside runSessionsResumeCommand below that does
// the actual work.
export const __internal = { runClassicCli, parseArgs };

const EXPORT_FORMATTERS = {
  json: formatSessionAsJson,
  jsonl: formatSessionAsJsonl,
  md: formatSessionAsMarkdown
};

function parsePositionalsAndFlags(rest) {
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  return { positionals, json };
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `[{ id, updatedAt, workspace, parentSessionId }]`, newest first
 *  (listSessions() already sorts this way). */
export async function gatherSessionsList() {
  return listSessions();
}

export function formatSessionsListHuman(rows) {
  if (rows.length === 0) return "No sessions found.\n";
  const header = ["ID", "UPDATED", "WORKSPACE"];
  const data = rows.map((r) => [
    r.id,
    r.updatedAt ? new Date(r.updatedAt).toISOString() : "unknown",
    r.workspace?.cwd || "(unknown)"
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmtRow(header), ...data.map(fmtRow)].join("\n") + "\n";
}

export function formatSessionsListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage sessions list [--json]",
      "",
      "Lists every stored session (~/.upstage-cli/sessions/), newest first.",
      "",
      "Options:",
      "  --json   Output as JSON: [{id, updatedAt, workspace, parentSessionId}]"
    ].join("\n") + "\n"
  );
}

export async function runSessionsListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const { json } = parsePositionalsAndFlags(rest);
  const rows = await gatherSessionsList();
  process.stdout.write(json ? formatSessionsListJson(rows) : formatSessionsListHuman(rows));
  return 0;
}

// ── show ─────────────────────────────────────────────────────────────────

function toSummary(session) {
  return {
    id: session.id,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    workspace: session.workspace || { cwd: null },
    parentSessionId: session.parentSessionId || null,
    historyCount: Array.isArray(session.history) ? session.history.length : 0,
    toolResultsCount: Array.isArray(session.toolResults) ? session.toolResults.length : 0,
    appliedPatchesCount: Array.isArray(session.appliedPatches) ? session.appliedPatches.length : 0,
    runtimeEventsCount: Array.isArray(session.runtimeEvents) ? session.runtimeEvents.length : 0
  };
}

/** Returns `{ result: <summary> }` or `{ error, code }` — `code: 2` for a
 *  missing `<id>` argument, `code: 1` for an id that doesn't resolve to a
 *  stored session (no more-specific "resource not found" precedent exists
 *  in this codebase's other 3.2.0 commands — mcp.mjs's `requireConfig`
 *  folds "unknown name" into its generic missing-argument code-2 path
 *  rather than distinguishing it — so this follows the plan's stated
 *  default of exit code 1 for "session not found"). */
export async function gatherSessionsShow({ id } = {}) {
  if (!id) return { error: "missing required <id> argument", code: 2 };
  let session;
  try {
    session = await loadSession(id);
  } catch {
    return { error: `no session found with id '${id}'`, code: 1 };
  }
  return { result: toSummary(session) };
}

export function formatShowHuman(summary) {
  const lines = [
    `id: ${summary.id}`,
    `created: ${summary.createdAt ? new Date(summary.createdAt).toISOString() : "unknown"}`,
    `updated: ${summary.updatedAt ? new Date(summary.updatedAt).toISOString() : "unknown"}`,
    `workspace: ${summary.workspace?.cwd || "(unknown)"}`
  ];
  if (summary.parentSessionId) lines.push(`forked from: ${summary.parentSessionId}`);
  lines.push(
    `history: ${summary.historyCount} entries`,
    `tool results: ${summary.toolResultsCount}`,
    `applied patches: ${summary.appliedPatchesCount}`,
    `runtime events: ${summary.runtimeEventsCount}`
  );
  return lines.join("\n") + "\n";
}

export function formatShowJson(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

function printShowUsage() {
  process.stdout.write(
    [
      "Usage: upstage sessions show <id> [--json]",
      "",
      "Prints one session's summary (timestamps, workspace, entry counts) —",
      "not a full dump. Use `upstage sessions export <id>` for that.",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

export async function runSessionsShowCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printShowUsage();
    return 0;
  }
  const { positionals, json } = parsePositionalsAndFlags(rest);
  const outcome = await gatherSessionsShow({ id: positionals[0] });
  if (outcome.error) {
    process.stderr.write(`upstage sessions show: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatShowJson(outcome.result) : formatShowHuman(outcome.result));
  return 0;
}

// ── resume ───────────────────────────────────────────────────────────────

function printResumeUsage() {
  process.stdout.write(
    [
      "Usage: upstage sessions resume <id>",
      "",
      "  Resumes a stored session — the SAME code path as running",
      "  `upstage --session <id>` directly (src/cli/index.mjs's",
      "  runClassicCli), not a reimplementation of it. Launches the",
      "  interactive TUI (or a one-shot prompt, if -p/--prompt is also",
      "  forwarded) exactly as that flow would.",
      "",
      "  Any extra flags after <id> are forwarded verbatim, e.g.:",
      "    upstage sessions resume abc123 --model solar-pro4"
    ].join("\n") + "\n"
  );
}

/**
 * `sessions resume <id>` produces identical behavior to `upstage --session
 * <id>` by construction, not by coincidence: it builds `args` via the exact
 * same `parseArgs()` function index.mjs's own `--session` handling uses
 * (called here with `["--session", id, ...anything after <id>]`), then
 * calls the exact same `runClassicCli(args)` function reference — see
 * index.mjs's doc comment on that export. `deps` exists purely so tests can
 * substitute both without exercising the real interactive TUI/registry
 * bootstrap; production callers never pass it.
 */
export async function runSessionsResumeCommand(rest = [], deps = {}) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printResumeUsage();
    return 0;
  }
  const { positionals } = parsePositionalsAndFlags(rest);
  const id = positionals[0];
  if (!id) {
    process.stderr.write("upstage sessions resume: missing required <id> argument\n");
    return 2;
  }

  const doLoadSession = deps.loadSession || loadSession;
  try {
    await doLoadSession(id);
  } catch {
    process.stderr.write(`upstage sessions resume: no session found with id '${id}'\n`);
    return 1;
  }

  const doParseArgs = deps.parseArgs || parseArgs;
  const doRunClassicCli = deps.runClassicCli || runClassicCli;
  const extraArgv = rest.filter((token) => token !== id);
  const args = doParseArgs(["--session", id, ...extraArgv]);
  await doRunClassicCli(args);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

// ── export ───────────────────────────────────────────────────────────────

function printExportUsage() {
  process.stdout.write(
    [
      "Usage: upstage sessions export <id> [--format md|json|jsonl] [--include-tool-io]",
      "",
      "  Formats a stored session as a transcript. `json` is the (redacted)",
      "  session object as-is; `jsonl` is one line per history/runtimeEvents",
      "  entry; `md` (the default) is a human-readable transcript.",
      "",
      "  By default, raw write_file/edit_file file bodies are elided to a",
      "  diff-stat-only summary (they're the most likely place a secret or a",
      "  large chunk of proprietary source ends up in a shared artifact).",
      "  Pass --include-tool-io to include them verbatim.",
      "",
      "Options:",
      "  --format <fmt>      md (default) | json | jsonl",
      "  --include-tool-io   Include raw write_file/edit_file bodies unredacted"
    ].join("\n") + "\n"
  );
}

/** Returns `{ result: <formatted string> }` or `{ error, code }`
 *  (`code: 2` for a missing/unknown `<id>` or bad `--format`, `code: 1` for
 *  an id that doesn't resolve to a stored session — see gatherSessionsShow's
 *  doc comment for why code 1 rather than 2 there). */
export async function gatherSessionsExport({ id, format = "md", includeToolIo = false } = {}) {
  if (!id) return { error: "missing required <id> argument", code: 2 };
  const formatter = EXPORT_FORMATTERS[format];
  if (!formatter) {
    return { error: `unknown --format '${format}' (expected md, json, or jsonl)`, code: 2 };
  }
  let session;
  try {
    session = await loadSession(id);
  } catch {
    return { error: `no session found with id '${id}'`, code: 1 };
  }
  return { result: formatter(session, { includeToolIo }) };
}

function parseExportFlags(rest) {
  const includeToolIo = rest.includes("--include-tool-io");
  let format = "md";
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--format") {
      format = rest[i + 1] || format;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    positionals.push(token);
  }
  return { id: positionals[0], format, includeToolIo };
}

export async function runSessionsExportCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printExportUsage();
    return 0;
  }
  const { id, format, includeToolIo } = parseExportFlags(rest);
  const outcome = await gatherSessionsExport({ id, format, includeToolIo });
  if (outcome.error) {
    process.stderr.write(`upstage sessions export: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(outcome.result);
  return 0;
}
