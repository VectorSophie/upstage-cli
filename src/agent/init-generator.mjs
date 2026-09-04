// Shared generation logic for `/init` (TUI slash command, src/ui/commands.mjs)
// and `upstage init` (CLI, src/cli/commands/init.mjs) — Task 7.10 of the
// 3.2.0 release plan. ONE implementation; both call sites are thin adapters
// over `generateUpstageMd()` below.
//
// Facts are gathered by calling existing tool logic AS PLAIN FUNCTIONS —
// `buildIntelligenceIndex`/`findSymbol`/`listModules` from
// `src/indexer/intelligence.mjs` (the exact module the `find_symbol` and
// `list_modules` tools in src/tools/builtin/intelligence-tools.mjs
// themselves call) and `detectProjectCommands` from
// `src/cli/lib/command-detection.mjs` (already shared with `upstage doctor`,
// Task 12.3). No agent-tool-call loop, no LLM turn — `/init` is
// deterministic, so it shouldn't cost a model call just to gather facts.
//
// Note on repo_map's `maxFiles: 100` default (src/tools/builtin/repo-map.mjs):
// that cap is too small for a meaningful architecture summary of this
// repo's ~123-file `src/` tree, and repo-map.mjs has no directory-aggregation
// mode to fall back on (its walk is inlined in the tool's `execute`, not a
// separately callable plain function). Rather than raising that cap, this
// module builds on `buildIntelligenceIndex` instead — the same underlying
// symbol/import data `find_symbol`/`list_modules` read, with a much higher
// default (`maxFiles: 800`, `maxDepth: 10`) — and aggregates at the
// DIRECTORY level rather than listing 100+ individual files. That sidesteps
// the cap entirely and produces a far more readable summary besides.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildIntelligenceIndex, findSymbol, listModules } from "../indexer/intelligence.mjs";
import { detectProjectCommands } from "../cli/lib/command-detection.mjs";

export const MARKER_START = "<!-- upstage:generated:start -->";
export const MARKER_END = "<!-- upstage:generated:end -->";

function upstageMdPath(cwd) {
  return join(cwd, "UPSTAGE.md");
}

async function readPackageJson(cwd) {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dirOf(relPath) {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "." : relPath.slice(0, idx);
}

// src/indexer/parsers/adapter.mjs's tree-sitter tags query (extractWithTreeSitter)
// emits one capture per matched node — both the `@name` capture (the real
// identifier) AND outer wrapping captures like `@function`/`@class`/`@export`
// (the whole matched node). Every capture is turned into a "symbol" with
// `name: cap.node.text`, so those outer captures end up with the *entire
// source text of the declaration* (often many lines) as their symbol name —
// a real bug in that adapter, found while building this generator. Fixing it
// is out of scope here (it's shared by `find_symbol`/`repo_map` well beyond
// `/init`, and warrants its own change+tests), so this module only defends
// itself: any index-derived symbol whose "name" doesn't look like a plausible
// identifier is dropped before it can pollute generated output.
function isPlausibleSymbolName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 80 && /^[A-Za-z_$][\w$.]*$/.test(name);
}

/**
 * Directory-level aggregation of the intelligence index — files/symbols
 * grouped by directory, sorted by file count, rather than a flat 100+-line
 * file list. This is the "directory-level aggregation strategy" called for
 * by the task's failure-modes note (see file header).
 */
export function aggregateDirectories(index, { limit = 18 } = {}) {
  const dirs = new Map();
  const ensure = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, { files: new Set(), symbolNames: [] });
    return dirs.get(dir);
  };
  for (const relPath of Object.keys(index.fileSignatures || {})) {
    ensure(dirOf(relPath)).files.add(relPath);
  }
  for (const symbol of index.symbols || []) {
    ensure(dirOf(symbol.file)).symbolNames.push(symbol.name);
  }
  const rows = Array.from(dirs.entries()).map(([dir, v]) => ({
    dir,
    fileCount: v.files.size,
    symbolCount: v.symbolNames.length,
    sample: Array.from(new Set(v.symbolNames)).slice(0, 5)
  }));
  rows.sort((a, b) => b.fileCount - a.fileCount || b.symbolCount - a.symbolCount || a.dir.localeCompare(b.dir));
  return rows.slice(0, limit);
}

/**
 * Reverse-import-count over `listModules()`'s edges: which internal modules
 * the most *other* files import. A structural "core modules" signal derived
 * straight from the same import graph `list_modules` exposes — not a guess.
 */
export function mostDependedUponModules(index, { limit = 8 } = {}) {
  const modules = listModules(index);
  const incoming = new Map();
  for (const { imports } of modules) {
    for (const dep of imports) {
      incoming.set(dep, (incoming.get(dep) || 0) + 1);
    }
  }
  return Array.from(incoming.entries())
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, limit);
}

// Generic (not repo-specific) probes — real hits only, nothing hardcoded to
// any particular project's symbol names.
const KEY_SYMBOL_HINTS = ["main", "run", "start", "init", "dispatch", "server", "app"];

/** Real `findSymbol()` matches for common architecture-entry-shaped names. */
function findKeySymbols(index) {
  const seen = new Set();
  const results = [];
  for (const hint of KEY_SYMBOL_HINTS) {
    for (const match of findSymbol(index, hint)) {
      const key = `${match.file}:${match.name}:${match.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(match);
      if (results.length >= 10) return results;
    }
  }
  return results;
}

function detectFrameworks(pkg) {
  if (!pkg) return [];
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.keys(deps).sort();
}

function fmtTable(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

/**
 * Gathers real facts about the repo at `cwd` and formats them as markdown —
 * the content that goes BETWEEN the generated-block markers. Pure data
 * gathering + formatting; no marker/file logic (see `mergeGeneratedBlock`
 * and `generateUpstageMd` below for that).
 */
export async function buildGeneratedContent(cwd) {
  const pkg = await readPackageJson(cwd);
  const index = await buildIntelligenceIndex(cwd);
  const commands = await detectProjectCommands(cwd);
  const fileCount = Object.keys(index.fileSignatures || {}).length;
  // See isPlausibleSymbolName's comment above — filters out the tree-sitter
  // adapter's mis-captured "whole declaration text as name" entries.
  const plausibleSymbols = (index.symbols || []).filter((s) => isPlausibleSymbolName(s?.name));
  const cleanIndex = { ...index, symbols: plausibleSymbols };
  const symbolCount = plausibleSymbols.length;
  const topModules = mostDependedUponModules(index); // reads importsByFile, unaffected by the symbol-name bug
  const dirs = aggregateDirectories(cleanIndex);
  const keySymbols = findKeySymbols(cleanIndex);
  const frameworks = detectFrameworks(pkg);

  const lines = [];
  lines.push(
    `_Generated by \`upstage init\` on ${new Date().toISOString().slice(0, 10)} — derived from static ` +
      "analysis of this repository (package.json + intelligence index), not hand-written. Content " +
      "outside the markers around this block is preserved across regenerations._"
  );
  lines.push("");

  // Architecture
  lines.push("## Architecture");
  lines.push("");
  if (pkg) {
    lines.push(
      `- **Package**: \`${pkg.name || "(unnamed)"}\`${pkg.version ? ` v${pkg.version}` : ""}` +
        `${pkg.description ? ` — ${pkg.description}` : ""}`
    );
  }
  lines.push(`- **Module system**: ${pkg?.type === "module" ? "ESM (`\"type\": \"module\"`)" : "CommonJS"}`);
  if (pkg?.engines && Object.keys(pkg.engines).length > 0) {
    lines.push(`- **Engines**: ${Object.entries(pkg.engines).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  lines.push(`- **Indexed source**: ${fileCount} files, ${symbolCount} symbols (parser: ${index.parserMode || "unknown"})`);
  if (topModules.length > 0) {
    lines.push("- **Most depended-upon internal modules** (by internal import count):");
    for (const m of topModules) lines.push(`  - \`${m.file}\` — imported by ${m.count} module${m.count === 1 ? "" : "s"}`);
  }
  lines.push("");

  // Entry Points
  lines.push("## Entry Points");
  lines.push("");
  if (pkg?.bin && Object.keys(pkg.bin).length > 0) {
    for (const [name, file] of Object.entries(pkg.bin)) lines.push(`- \`${name}\` → \`${file}\``);
  } else {
    lines.push("- No `bin` entries declared in `package.json`.");
  }
  if (pkg?.main) lines.push(`- \`main\` → \`${pkg.main}\``);
  if (keySymbols.length > 0) {
    lines.push("- Detected entry-point-shaped symbols:");
    for (const s of keySymbols) {
      // Tree-sitter-parsed files only carry a clean, non-polluted kind on
      // the plain `@name` capture, whose capture-group label is literally
      // "name" (see isPlausibleSymbolName's comment above) — not useful to
      // show verbatim, so it's omitted rather than printed as "(name)".
      const kindLabel = s.kind && s.kind !== "name" ? ` (${s.kind})` : "";
      lines.push(`  - \`${s.name}\`${kindLabel} — \`${s.file}:${s.line}\``);
    }
  }
  lines.push("");

  // Important Directories
  lines.push("## Important Directories");
  lines.push("");
  if (dirs.length > 0) {
    lines.push(
      fmtTable(
        ["Directory", "Files", "Symbols", "Sample symbols"],
        dirs.map((d) => [
          `\`${d.dir}\``,
          String(d.fileCount),
          String(d.symbolCount),
          d.sample.map((s) => `\`${s}\``).join(", ") || "—"
        ])
      )
    );
  } else {
    lines.push("_No source directories indexed._");
  }
  lines.push("");

  // Build / Test / Lint / Typecheck — build/dev read directly off
  // package.json.scripts (command-detection.mjs only covers lint/typecheck/
  // test, see its own header comment); lint/typecheck/test reuse
  // detectProjectCommands() verbatim, per the task's explicit instruction
  // not to re-derive this.
  const buildScript = pkg?.scripts?.build;
  const devScriptName = pkg?.scripts?.dev ? "dev" : pkg?.scripts?.start ? "start" : null;

  lines.push("## Build");
  lines.push("");
  lines.push(buildScript ? `- \`npm run build\` → \`${buildScript}\`` : "- No build script detected (zero-build-step project).");
  if (devScriptName) lines.push(`- Dev/run: \`npm run ${devScriptName}\` → \`${pkg.scripts[devScriptName]}\``);
  lines.push("");

  lines.push("## Test");
  lines.push("");
  lines.push(commands.test ? `- \`npm run ${commands.test.script}\` → \`${commands.test.command}\`` : "- No test script detected.");
  lines.push("");

  lines.push("## Lint");
  lines.push("");
  lines.push(commands.lint ? `- \`npm run ${commands.lint.script}\` → \`${commands.lint.command}\`` : "- No lint script detected.");
  lines.push("");

  lines.push("## Typecheck");
  lines.push("");
  lines.push(commands.typecheck ? `- \`npm run ${commands.typecheck.script}\` → \`${commands.typecheck.command}\`` : "- No typecheck script detected.");
  lines.push("");

  // Runtime & Frameworks
  lines.push("## Runtime & Frameworks");
  lines.push("");
  lines.push(frameworks.length > 0 ? frameworks.map((f) => `\`${f}\``).join(", ") : "_No dependencies declared in `package.json`._");

  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Pure merge: given existing UPSTAGE.md content (or null/"" if none) and a
 * freshly generated block body, returns the new full file content plus what
 * kind of merge happened. No disk I/O — see `generateUpstageMd` for that.
 *
 * Marker rules (per the task spec):
 *  - no existing content (file absent or empty)   → file becomes just the
 *    generated block.
 *  - has BOTH markers, start before end            → replace ONLY what's
 *    between them; everything before/after is untouched.
 *  - has content but no valid marker pair (no       → APPEND a new block at
 *    markers yet, or malformed/out-of-order)          the end. Never
 *                                                      overwrite hand-written
 *                                                      content.
 */
export function mergeGeneratedBlock(existingContent, blockBody) {
  const wrapped = `${MARKER_START}\n${blockBody}\n${MARKER_END}`;
  const existing = existingContent || "";

  if (existing.trim().length === 0) {
    return { content: `${wrapped}\n`, action: "created" };
  }

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    return { content: `${before}${wrapped}${after}`, action: "updated" };
  }

  // No valid marker pair — preserve the hand-written file as-is and append.
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${sep}${wrapped}\n`, action: "appended" };
}

/**
 * Full orchestration: gather facts, merge into any existing UPSTAGE.md, and
 * (unless `dryRun`) write the result. Both the `/init` slash command
 * (src/ui/commands.mjs) and `upstage init` (src/cli/commands/init.mjs) call
 * this — it is the single source of truth for generation logic.
 *
 * Judgment call on `refresh` vs. default behavior: the task's own framing is
 * that regeneration is "cheap and deterministic" and explicitly says not to
 * invent a staleness heuristic. With no staleness signal to gate on, plain
 * `/init` already always regenerates the block (there's nothing else
 * sensible for it to do against a project that's meant to stay current) —
 * so `refresh` is accepted for interface/CLI-flag symmetry with the plan's
 * spec but doesn't change behavior here; it's a documented no-op alias, not
 * a distinct code path. `refreshRequested` is still threaded through to the
 * result so callers can echo it back if useful.
 */
export async function generateUpstageMd({ cwd = process.cwd(), refresh = false, dryRun = false } = {}) {
  const path = upstageMdPath(cwd);
  const blockBody = await buildGeneratedContent(cwd);

  const existingContent = existsSync(path) ? await readFile(path, "utf8") : null;
  const { content, action } = mergeGeneratedBlock(existingContent, blockBody);

  if (dryRun) {
    return { path, action: "dry-run", written: false, block: blockBody, content, refreshRequested: Boolean(refresh) };
  }

  await writeFile(path, content, "utf8");
  return { path, action, written: true, block: blockBody, content, refreshRequested: Boolean(refresh) };
}
