// `upstage mcp list/status/test/tools/show` — Task 12.4 of the 3.2.0 release
// plan (§6 command tree, §7.Q design detail).
//
// Five real subcommands over the two existing MCP config primitives
// (src/tools/mcp/config.mjs): `loadMcpServerConfigs` and
// `connectConfiguredServers`. Neither is reimplemented here — every
// connection attempt below goes through `connectConfiguredServers`, exactly
// like `doctor.mjs`'s own `gatherMcpStatus()` (Task 12.3) already does for
// its "Extensions" section. `mcp add`/`mcp remove` remain router stubs —
// out of this task's scope.
//
// TIMEOUT: every connect attempt uses CONNECT_TIMEOUT_MS (5s) below, the
// same value as doctor.mjs's MCP_CHECK_TIMEOUT_MS — same reasoning (a
// slow/hanging stdio server must never hang the command indefinitely), and
// matching doctor's already-established convention for this exact
// primitive rather than inventing a different number.
//
// FAILURE ISOLATION: `connectConfiguredServers` connects each configured
// server in turn and isolates failures itself — a server whose `connect()`
// throws is logged (via the `onLog` callback) and skipped, never thrown
// past the function or allowed to abort the remaining servers. It does NOT
// return per-server error detail in its return value, only in that log
// message, so `connectOne()` below captures the log line (calling it with a
// single-element config array so there is never any ambiguity about which
// server a captured message belongs to) and strips the known
// `could not connect server '<name>': ` prefix to recover the real
// `Error.message` for `mcp test`/`mcp tools`, which are both required to
// report the actual error rather than a bare "failed".
//
// SECURITY: `mcp show` NEVER prints a real env/header value — see
// `redactValues()`/`buildShowConfig()` below, the only functions in this
// file that touch `cfg.env`/`cfg.headers`, and both discard the actual
// value immediately, keeping only the key name with a fixed "***" stand-in.

import { loadMcpServerConfigs, connectConfiguredServers } from "../../tools/mcp/config.mjs";
import { loadSettings } from "../../config/settings.mjs";

const CONNECT_TIMEOUT_MS = 5000;

// ── shared setup ─────────────────────────────────────────────────────────

async function resolveSettings(cwd, settings) {
  return settings || (await loadSettings({ cwd }));
}

/** Resolves settings (unless already given) and loads the merged server
 *  configs — the `resolveSettings` + `loadMcpServerConfigs` pairing every
 *  subcommand below needs before it can do anything else. */
async function loadConfigs(cwd, settings) {
  const resolved = await resolveSettings(cwd, settings);
  return loadMcpServerConfigs(cwd, resolved, { onLog: () => {} });
}

function findConfig(configs, name) {
  return configs.find((c) => c.name === name) || null;
}

/** Common "resolve <name> to one existing config, or a usage error" pattern
 *  shared by `tools`/`show` (both require exactly one named server up
 *  front). `test` does NOT use this — an absent name there means "test all
 *  configured servers", not an error, so it has its own inline handling. */
function requireConfig(configs, name) {
  if (!name) return { error: "missing required <name> argument", code: 2 };
  const cfg = findConfig(configs, name);
  if (!cfg) return { error: `no MCP server named '${name}' configured`, code: 2 };
  return { cfg };
}

function parsePositionalsAndFlags(rest) {
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  return { positionals, json };
}

/**
 * Loads every configured server and connects to all of them in one batch
 * call (failures isolated by connectConfiguredServers itself). Returns the
 * raw configs, a name->client map of the servers that connected, and
 * closeAll() for cleanup. Shared by `list`/`status`.
 */
async function connectAll(cwd, settings) {
  const configs = await loadConfigs(cwd, settings);
  const { servers, closeAll } = await connectConfiguredServers(configs, {
    cwd,
    timeoutMs: CONNECT_TIMEOUT_MS,
    onLog: () => {}
  });
  const byName = new Map(servers.map((s) => [s.name, s.client]));
  return { configs, byName, closeAll };
}

/**
 * Connects to exactly ONE config in isolation (still via
 * connectConfiguredServers — see this file's header for why a single-
 * element array is used rather than hand-building a client). Captures the
 * real underlying error message on failure. Shared by `test` and `tools`.
 */
async function connectOne(cfg, cwd) {
  let logged = null;
  const { servers, closeAll } = await connectConfiguredServers([cfg], {
    cwd,
    timeoutMs: CONNECT_TIMEOUT_MS,
    onLog: (msg) => { logged = msg; }
  });
  if (servers.length === 0) {
    const prefix = `could not connect server '${cfg.name}': `;
    const error = logged && logged.startsWith(prefix)
      ? logged.slice(prefix.length)
      : (logged || "connection failed (no details available)");
    return { connected: false, client: null, error, closeAll };
  }
  return { connected: true, client: servers[0].client, error: null, closeAll };
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `[{ name, transport, status, toolCount }]`. A failed server has
 *  `status: "failed"` and `toolCount: null` — it does NOT abort the loop
 *  over the remaining configured servers. */
export async function gatherMcpList({ cwd = process.cwd(), settings } = {}) {
  const { configs, byName, closeAll } = await connectAll(cwd, settings);
  const rows = [];
  for (const cfg of configs) {
    const client = byName.get(cfg.name);
    if (!client) {
      rows.push({ name: cfg.name, transport: cfg.transport, status: "failed", toolCount: null });
      continue;
    }
    let toolCount;
    try {
      toolCount = (await client.listTools()).length;
    } catch {
      // A successful connect followed by a failing tools/list is unusual
      // but not fatal to the listing — report 0 rather than drop the row.
      toolCount = 0;
    }
    rows.push({ name: cfg.name, transport: cfg.transport, status: "connected", toolCount });
  }
  await closeAll().catch(() => {});
  return rows;
}

export function formatListHuman(rows) {
  if (rows.length === 0) return "No MCP servers configured.\n";
  const header = ["NAME", "TRANSPORT", "STATUS", "TOOLS"];
  const data = rows.map((r) => [r.name, r.transport, r.status, r.toolCount === null ? "-" : String(r.toolCount)]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmtRow(header), ...data.map(fmtRow)].join("\n") + "\n";
}

export function formatListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage mcp list [--json]",
      "",
      "Lists every configured MCP server with its transport, connection status,",
      "and tool count. A server that fails to connect is shown with",
      "STATUS=failed, TOOLS=- and does NOT abort the listing — the other",
      "configured servers still show.",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, transport, status, toolCount}]"
    ].join("\n") + "\n"
  );
}

export async function runMcpListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const { json } = parsePositionalsAndFlags(rest);
  const rows = await gatherMcpList({ cwd: process.cwd() });
  process.stdout.write(json ? formatListJson(rows) : formatListHuman(rows));
  return 0;
}

// ── status ───────────────────────────────────────────────────────────────

/** A narrower summary than `list` — just name + status, no transport or
 *  tool count. Returns `[{ name, status }]`. */
export async function gatherMcpStatus({ cwd = process.cwd(), settings } = {}) {
  const { configs, byName, closeAll } = await connectAll(cwd, settings);
  const rows = configs.map((cfg) => ({
    name: cfg.name,
    status: byName.has(cfg.name) ? "connected" : "failed"
  }));
  await closeAll().catch(() => {});
  return rows;
}

export function formatStatusHuman(rows) {
  if (rows.length === 0) return "No MCP servers configured.\n";
  return rows.map((r) => `${r.status === "connected" ? "✓" : "✗"} ${r.name}: ${r.status}`).join("\n") + "\n";
}

export function formatStatusJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printStatusUsage() {
  process.stdout.write(
    [
      "Usage: upstage mcp status [--json]",
      "",
      "A narrower, single-line-per-server summary of MCP server connectivity",
      "(name + connected/failed only — see `upstage mcp list` for transport",
      "and tool counts).",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, status}]"
    ].join("\n") + "\n"
  );
}

export async function runMcpStatusCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printStatusUsage();
    return 0;
  }
  const { json } = parsePositionalsAndFlags(rest);
  const rows = await gatherMcpStatus({ cwd: process.cwd() });
  process.stdout.write(json ? formatStatusJson(rows) : formatStatusHuman(rows));
  return 0;
}

// ── test ─────────────────────────────────────────────────────────────────

/** Re-attempts connection for ONE named server, or ALL configured servers
 *  when `name` is omitted. Returns `{ results: [{name, transport, status,
 *  error}] }` on success, or `{ error, code }` for a bad `name`. */
export async function gatherMcpTestResults({ cwd = process.cwd(), settings, name } = {}) {
  const configs = await loadConfigs(cwd, settings);

  let targets = configs;
  if (name) {
    const cfg = findConfig(configs, name);
    if (!cfg) return { error: `no MCP server named '${name}' configured`, code: 2 };
    targets = [cfg];
  }

  const results = [];
  for (const cfg of targets) {
    const { connected, error, closeAll } = await connectOne(cfg, cwd);
    await closeAll().catch(() => {});
    results.push({
      name: cfg.name,
      transport: cfg.transport,
      status: connected ? "pass" : "fail",
      error: connected ? null : error
    });
  }
  return { results };
}

export function formatTestHuman(results) {
  if (results.length === 0) return "No MCP servers configured.\n";
  return results.map((r) => {
    const glyph = r.status === "pass" ? "✓" : "✗";
    const suffix = r.status === "fail" ? ` — ${r.error}` : "";
    return `${glyph} ${r.name} (${r.transport})${suffix}`;
  }).join("\n") + "\n";
}

export function formatTestJson(results) {
  return `${JSON.stringify(results, null, 2)}\n`;
}

function printTestUsage() {
  process.stdout.write(
    [
      "Usage: upstage mcp test [<name>] [--json]",
      "",
      "Re-attempts connection for one named MCP server, or all configured",
      "servers if <name> is omitted. Reports pass/fail with the actual",
      "connection error for any failure.",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, transport, status, error}]"
    ].join("\n") + "\n"
  );
}

export async function runMcpTestCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printTestUsage();
    return 0;
  }
  const { positionals, json } = parsePositionalsAndFlags(rest);
  const name = positionals[0];

  const outcome = await gatherMcpTestResults({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage mcp test: ${outcome.error}\n`);
    return outcome.code;
  }
  const { results } = outcome;
  process.stdout.write(json ? formatTestJson(results) : formatTestHuman(results));
  // Unlike `doctor`/`skills install`, `test`'s entire job is a pass/fail
  // verdict — a caller scripting against it needs a non-zero exit when a
  // targeted server actually failed, not just a report. `[].every(...)` is
  // vacuously true, so zero configured servers naturally exits 0 here too,
  // with no separate early-return needed.
  return results.every((r) => r.status === "pass") ? 0 : 1;
}

// ── tools ────────────────────────────────────────────────────────────────

/** Connects to ONE named server and lists its tools. Returns
 *  `{ result: { server, toolCount, tools: [{name, description}] } }` or
 *  `{ error, code }` (2 = bad/missing name, 1 = connection/list failure). */
export async function gatherMcpTools({ cwd = process.cwd(), settings, name } = {}) {
  const configs = await loadConfigs(cwd, settings);
  const found = requireConfig(configs, name);
  if (found.error) return found;
  const { cfg } = found;

  const { connected, client, error, closeAll } = await connectOne(cfg, cwd);
  if (!connected) {
    await closeAll().catch(() => {});
    return { error: `could not connect to '${name}': ${error}`, code: 1 };
  }

  let tools;
  try {
    tools = await client.listTools();
  } catch (err) {
    await closeAll().catch(() => {});
    return { error: `failed to list tools for '${name}': ${err instanceof Error ? err.message : String(err)}`, code: 1 };
  }
  await closeAll().catch(() => {});

  return {
    result: {
      server: name,
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description || "" }))
    }
  };
}

export function formatToolsHuman(result) {
  const lines = [`${result.server}: ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}`, ""];
  for (const t of result.tools) {
    lines.push(`  ${t.name}${t.description ? ` — ${t.description}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function formatToolsJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function printToolsUsage() {
  process.stdout.write(
    [
      "Usage: upstage mcp tools <name> [--json]",
      "",
      "Connects to one named MCP server and lists its tools (name +",
      "description + count).",
      "",
      "Options:",
      "  --json   Output as JSON: {server, toolCount, tools: [{name, description}]}"
    ].join("\n") + "\n"
  );
}

export async function runMcpToolsCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printToolsUsage();
    return 0;
  }
  const { positionals, json } = parsePositionalsAndFlags(rest);
  const name = positionals[0];

  const outcome = await gatherMcpTools({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage mcp tools: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatToolsJson(outcome.result) : formatToolsHuman(outcome.result));
  return 0;
}

// ── show ─────────────────────────────────────────────────────────────────

// The ONLY two functions in this file allowed to look at `cfg.env` /
// `cfg.headers` — both discard the actual value immediately and keep only
// the key name. Never call these such that their return value is skipped
// in favor of the original object.
function redactValues(obj) {
  const out = {};
  for (const key of Object.keys(obj || {})) out[key] = "***";
  return out;
}

function buildShowConfig(cfg) {
  if (cfg.transport === "http") {
    return { name: cfg.name, transport: "http", url: cfg.url, headers: redactValues(cfg.headers) };
  }
  return { name: cfg.name, transport: "stdio", command: cfg.command, args: [...cfg.args], env: redactValues(cfg.env) };
}

/** Returns `{ result: <redacted config> }` or `{ error, code }` (always
 *  code 2 — a missing/unknown `name` is a usage error, `show` never
 *  connects to anything). `result.env`/`result.headers` values are ALWAYS
 *  the fixed string "***" — see `redactValues()` above. */
export async function gatherMcpShow({ cwd = process.cwd(), settings, name } = {}) {
  const configs = await loadConfigs(cwd, settings);
  const found = requireConfig(configs, name);
  if (found.error) return found;
  return { result: buildShowConfig(found.cfg) };
}

export function formatShowHuman(shown) {
  const lines = [`name: ${shown.name}`, `transport: ${shown.transport}`];
  if (shown.transport === "http") {
    lines.push(`url: ${shown.url}`);
    lines.push("headers:");
    const keys = Object.keys(shown.headers);
    if (keys.length === 0) lines.push("  (none)");
    else for (const k of keys) lines.push(`  ${k}: ${shown.headers[k]}`);
  } else {
    lines.push(`command: ${shown.command}`);
    lines.push(`args: ${shown.args.length > 0 ? shown.args.join(" ") : "(none)"}`);
    lines.push("env:");
    const keys = Object.keys(shown.env);
    if (keys.length === 0) lines.push("  (none)");
    else for (const k of keys) lines.push(`  ${k}: ${shown.env[k]}`);
  }
  return lines.join("\n") + "\n";
}

export function formatShowJson(shown) {
  return `${JSON.stringify(shown, null, 2)}\n`;
}

function printShowUsage() {
  process.stdout.write(
    [
      "Usage: upstage mcp show <name> [--json]",
      "",
      "Prints one server's configuration with env/header VALUES redacted to",
      "key-presence only (e.g. `OPENAI_API_KEY: \"***\"`) — the actual secret",
      "value is never printed, in either output format.",
      "",
      "Options:",
      "  --json   Output as JSON (same redaction applies)"
    ].join("\n") + "\n"
  );
}

export async function runMcpShowCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printShowUsage();
    return 0;
  }
  const { positionals, json } = parsePositionalsAndFlags(rest);
  const name = positionals[0];

  const outcome = await gatherMcpShow({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage mcp show: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatShowJson(outcome.result) : formatShowHuman(outcome.result));
  return 0;
}
