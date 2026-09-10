// `upstage config list/get/set/path/edit` — Task 12.7 of the 3.2.0 release
// plan (§7.T design detail).
//
// `list [--effective]` is the one place genuinely new logic is needed:
// `loadSettingsWithProvenance()` (src/config/settings.mjs) attributes each
// top-level settings key to the cascade layer that last set it, via the
// multi-pass-diff approach documented on that function. Plain `list` (no
// flag) shows the effective KEY/VALUE pairs with no SOURCE column;
// `--effective` adds it.
//
// `get <key>`/`set <key> <value>` both use dot-path key access (e.g.
// `permissions.defaultMode`) against the SAME SINGLE file —
// `<cwd>/.upstage/settings.json` — and ONLY that file. Per the 3.2.0 plan's
// §7.T design detail: "`config get <key>`/`config set <key> <value>` operate
// on `<cwd>/.upstage/settings.json` specifically (never silently writing to
// [for `set`] or reading from [for `get`] the global or local-override
// file)". Neither command ever touches the global (`~/.upstage/settings.json`)
// or project-local (`settings.local.json`) files. `get` deliberately does
// NOT read the merged/effective cascade (`loadSettings()`) — that would let
// it return a value that was never written to, and isn't present in, the
// project file `set` writes to, silently breaking the `set foo bar` →
// `get foo` round trip whenever a higher-priority layer (env, local
// settings) also sets that key. A key absent from the project file is
// reported distinctly ("not set in project settings") rather than as a
// found value, and points at `config list --effective` — the command this
// plan already designed for the merged view with provenance. `set` reads
// the existing project settings file (if any) rather than starting from the
// merged/effective view, so it never bakes global/env-derived values into
// the project file as a side effect of setting one unrelated key. A project
// settings file that exists but fails to parse as JSON is treated as a hard
// error (code 1) rather than silently overwritten (for `set`) or ignored
// (for `get`) — corrupting, or pretending not to see, a user's existing (if
// malformed) config file would be worse than refusing to proceed.
//
// `path` prints the resolved project settings file path (no I/O). `edit`
// opens `$EDITOR` on that same file, creating it with `{}` first if it
// doesn't exist yet so the editor always opens on valid JSON.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

import {
  SETTINGS_SCHEMA,
  loadSettings,
  loadSettingsWithProvenance,
  projectSettingsPath
} from "../../config/settings.mjs";

// ── dot-path helpers ─────────────────────────────────────────────────────

function getByPath(obj, dotPath) {
  const parts = dotPath.split(".").filter(Boolean);
  if (parts.length === 0) return { found: false };
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) {
      return { found: false };
    }
    cur = cur[part];
  }
  return { found: true, value: cur };
}

function setByPath(obj, dotPath, value) {
  const parts = dotPath.split(".").filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== "object" || cur[part] === null || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/** `config set`'s value parsing: try JSON first (so `true`/`8192`/`"a,b"`/
 *  `{"a":1}` all parse to their natural type), falling back to the raw
 *  string for anything that isn't valid JSON (e.g. `dark`, a bare word). */
function parseSetValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function formatValue(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `{ rows, effective }`. `rows` is `[{key, value}]` (plain) or
 *  `[{key, value, source}]` (effective=true), one row per top-level
 *  SETTINGS_SCHEMA key, in schema-declaration order. */
export async function gatherConfigList({ cwd = process.cwd(), effective = false } = {}) {
  if (!effective) {
    const settings = await loadSettings({ cwd });
    const rows = Object.keys(SETTINGS_SCHEMA).map((key) => ({ key, value: settings[key] }));
    return { rows, effective: false };
  }
  const { settings, provenance } = await loadSettingsWithProvenance({ cwd });
  const rows = Object.keys(SETTINGS_SCHEMA).map((key) => ({
    key,
    value: settings[key],
    source: provenance[key]
  }));
  return { rows, effective: true };
}

export function formatConfigListHuman({ rows, effective }) {
  if (rows.length === 0) return "(no settings)\n";
  const header = effective ? ["KEY", "VALUE", "SOURCE"] : ["KEY", "VALUE"];
  const data = rows.map((r) => {
    const cols = [r.key, formatValue(r.value)];
    if (effective) cols.push(r.source);
    return cols;
  });
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmtRow(header), ...data.map(fmtRow)].join("\n") + "\n";
}

export function formatConfigListJson({ rows }) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage config list [--effective] [--json]",
      "",
      "Lists every top-level settings key and its effective value. With",
      "--effective, adds a SOURCE column naming which cascade layer last set",
      "it: 'default' | 'global settings' | 'project settings' |",
      "'project local settings' | 'env'.",
      "",
      "Options:",
      "  --effective   Show the SOURCE column",
      "  --json        Output as JSON: [{key, value}] or [{key, value, source}]"
    ].join("\n") + "\n"
  );
}

export async function runConfigListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const effective = rest.includes("--effective");
  const json = rest.includes("--json");
  const outcome = await gatherConfigList({ cwd: process.cwd(), effective });
  process.stdout.write(json ? formatConfigListJson(outcome) : formatConfigListHuman(outcome));
  return 0;
}

// ── get ──────────────────────────────────────────────────────────────────

/** Returns `{ result: { key, value, path } }` or `{ error, code }`
 *  (2 = missing key argument, 1 = key not present in the project settings
 *  file, OR the project settings file exists but is not valid JSON). Reads
 *  ONLY `<cwd>/.upstage/settings.json` — the same file `set` writes to —
 *  never the merged/effective cascade. */
export async function gatherConfigGet({ cwd = process.cwd(), key } = {}) {
  if (!key) return { error: "missing required <key> argument", code: 2 };
  const filePath = projectSettingsPath(cwd);

  let data = {};
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
      return {
        error: `${filePath} exists but is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        code: 1
      };
    }
  }

  const { found, value } = getByPath(data, key);
  if (!found) {
    return {
      error: `${key} is not set in project settings (run 'config list --effective' to see the resolved value and its source)`,
      code: 1
    };
  }
  return { result: { key, value, path: filePath } };
}

export function formatGetHuman(result) {
  return `${formatValue(result.value)}\n`;
}

export function formatGetJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function printGetUsage() {
  process.stdout.write(
    [
      "Usage: upstage config get <key> [--json]",
      "",
      "Prints one settings value by dot-path key (e.g.",
      "`permissions.defaultMode`) read from <cwd>/.upstage/settings.json (the",
      "project settings file) — the same file `config set` writes to. NEVER",
      "reads the global or project-local settings files, or env overrides. If",
      "the key isn't present in the project file, exits 1 with a message",
      "pointing at `config list --effective` for the merged view with",
      "provenance.",
      "",
      "Options:",
      "  --json   Output as JSON: {key, value, path}"
    ].join("\n") + "\n"
  );
}

export async function runConfigGetCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printGetUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const key = positionals[0];

  const outcome = await gatherConfigGet({ cwd: process.cwd(), key });
  if (outcome.error) {
    process.stderr.write(`upstage config get: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatGetJson(outcome.result) : formatGetHuman(outcome.result));
  return 0;
}

// ── set ──────────────────────────────────────────────────────────────────

/** Reads (or initializes) `<cwd>/.upstage/settings.json`, sets one dot-path
 *  key, and writes it back — and ONLY that file, never global or local.
 *  Returns `{ result: { key, value, path } }` or `{ error, code }`
 *  (2 = missing key/value argument, 1 = existing file is not valid JSON —
 *  refused rather than silently clobbered). */
export async function gatherConfigSet({ cwd = process.cwd(), key, value } = {}) {
  if (!key || value === undefined) {
    return { error: "usage: config set <key> <value>", code: 2 };
  }
  const filePath = projectSettingsPath(cwd);

  let data = {};
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
      return {
        error: `${filePath} exists but is not valid JSON — refusing to overwrite it (${err instanceof Error ? err.message : String(err)})`,
        code: 1
      };
    }
  }

  const parsedValue = parseSetValue(value);
  setByPath(data, key, parsedValue);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");

  return { result: { key, value: parsedValue, path: filePath } };
}

export function formatSetHuman(result) {
  return `set ${result.key} = ${formatValue(result.value)} (${result.path})\n`;
}

export function formatSetJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function printSetUsage() {
  process.stdout.write(
    [
      "Usage: upstage config set <key> <value> [--json]",
      "",
      "Sets one dot-path key in <cwd>/.upstage/settings.json (the project",
      "settings file). NEVER writes to the global or project-local settings",
      "files. <value> is parsed as JSON when possible (true/8192/\"x\"/{...}),",
      "otherwise stored as the raw string.",
      "",
      "Options:",
      "  --json   Output as JSON: {key, value, path}"
    ].join("\n") + "\n"
  );
}

export async function runConfigSetCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printSetUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const [key, value] = positionals;

  const outcome = await gatherConfigSet({ cwd: process.cwd(), key, value });
  if (outcome.error) {
    process.stderr.write(`upstage config set: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatSetJson(outcome.result) : formatSetHuman(outcome.result));
  return 0;
}

// ── path ─────────────────────────────────────────────────────────────────

function printPathUsage() {
  process.stdout.write(
    [
      "Usage: upstage config path",
      "",
      "Prints the resolved path to the active project's settings file",
      "(<cwd>/.upstage/settings.json) — the same file `config set`/`config",
      "edit` operate on. No I/O — the file need not exist yet."
    ].join("\n") + "\n"
  );
}

export async function runConfigPathCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printPathUsage();
    return 0;
  }
  process.stdout.write(`${projectSettingsPath(process.cwd())}\n`);
  return 0;
}

// ── edit ─────────────────────────────────────────────────────────────────

function printEditUsage() {
  process.stdout.write(
    [
      "Usage: upstage config edit",
      "",
      "Opens $EDITOR on <cwd>/.upstage/settings.json (creating it with `{}`",
      "first if it doesn't exist yet)."
    ].join("\n") + "\n"
  );
}

/**
 * Router entry point. Not covered by automated tests beyond -h/--help and
 * the missing-$EDITOR path — actually launching an interactive editor
 * process is exercised manually, same as App.mjs's own external-editor
 * flow this reuses the spawnSync(..., {stdio: "inherit"}) pattern from.
 */
export async function runConfigEditCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printEditUsage();
    return 0;
  }
  const editor = process.env.EDITOR;
  if (!editor) {
    process.stderr.write("upstage config edit: EDITOR is not set — set the EDITOR environment variable\n");
    return 4;
  }

  const filePath = projectSettingsPath(process.cwd());
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{}\n", "utf-8");
  }

  const result = spawnSync(editor, [filePath], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`upstage config edit: failed to launch '${editor}': ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}
