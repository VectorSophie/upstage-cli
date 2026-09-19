// `upstage doctor` — Task 12.3 of the 3.2.0 release plan.
//
// A read-only diagnostic sweep across six sections (Core / Upstage / Project /
// Extensions / Security / Verification). This is almost entirely composition
// over primitives that already exist elsewhere in the codebase — see the
// per-section comments below for exactly what's reused vs. computed locally.
//
// Design contract (per the plan's Task 12.3 acceptance criteria):
//   - Every individual check is run through `runCheck()`, a single uniform
//     harness that catches any throw and normalizes it to `status: "fail"`.
//     No check function is allowed its own ad-hoc try/catch around the
//     *outer* shape — inner try/catch for finer-grained partial results is
//     fine (e.g. "3 of 4 loaders succeeded"), but the harness is what
//     guarantees one throwing check can never crash the whole command.
//   - The command's own exit code is 0 whenever it *ran* and produced a
//     report — individual checks reporting "fail"/"warn" are data, not a
//     command failure.
//   - Never print secret *values* — API keys, MCP server `env`/`headers`
//     values, etc. At most a presence indicator ("configured") or a masked
//     prefix. See the `redactedKeyHint()` helper below — the ONLY place this
//     module ever touches an env var's actual key material.

import { existsSync } from "node:fs";
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkProviderKeys } from "../../core/providers.mjs";
import { isGitRepo } from "../../core/worktree.mjs";
import { loadMcpServerConfigs, connectConfiguredServers } from "../../tools/mcp/config.mjs";
import { createRegistryWithExtensions } from "../../tools/create-registry.mjs";
import { SkillsLoader } from "../../skills/loader.mjs";
import { AgentLoader } from "../../agents/loader.mjs";
import { PluginLoader } from "../../plugins/loader.mjs";
import { DEFAULT_LOOP_BUDGET, DEFAULT_POLICY } from "../../config/defaults.mjs";
import { loadSettings } from "../../config/settings.mjs";
import { getModelCapabilities } from "../../model/model-capabilities.mjs";
import { loadIntelligenceIndexFromDisk } from "../../indexer/store.mjs";
import { getIndexHealth } from "../../indexer/intelligence.mjs";
import { PARSERS } from "../../indexer/parsers/adapter.mjs";
import { detectInstallType } from "../lib/install-type.mjs";
import { detectProjectCommands } from "../lib/command-detection.mjs";
import { findChrome } from "../../browser/discovery.mjs";

// Short — a doctor sweep must never hang on a misbehaving MCP server. This
// bounds both the connect handshake and any request made during it (see
// stdio-client.mjs / http-client.mjs, both accept `timeoutMs`).
const MCP_CHECK_TIMEOUT_MS = 5000;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// ── check harness ────────────────────────────────────────────────────────

/**
 * Runs one check function and normalizes its outcome. This is the ONLY place
 * a throw from a check function is caught — every check in every section
 * goes through this, uniformly, so a throwing check can never crash the
 * command or skip the checks after it.
 *
 * `fn` may return:
 *   - a plain value → wrapped as `{ status: "pass", detail: String(value) }`
 *   - `{ status, detail }` → used as-is (status defaults to "pass")
 *   - it may throw/reject → normalized to `{ status: "fail", detail: <message> }`
 */
export async function runCheck(name, fn) {
  try {
    const result = await fn();
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return {
        name,
        status: result.status || "pass",
        detail: result.detail === undefined || result.detail === null ? "" : String(result.detail)
      };
    }
    return { name, status: "pass", detail: result === undefined || result === null ? "" : String(result) };
  } catch (err) {
    return { name, status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function runSection(name, checkDefs) {
  const checks = [];
  for (const [checkName, fn] of checkDefs) {
    checks.push(await runCheck(checkName, fn));
  }
  return { name, checks };
}

// Never returns the actual key value — only a presence indicator. This is
// the one function in this module allowed to look at an env var that might
// hold a secret, and it deliberately throws away the value immediately.
function redactedKeyHint(envValue) {
  if (typeof envValue !== "string" || envValue.length === 0) {
    return "not configured";
  }
  return "configured";
}

// ── Core ─────────────────────────────────────────────────────────────────

async function readPackageVersion() {
  const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(raw);
  return pkg.version || "unknown";
}

async function checkPathResolution() {
  const isWin = process.platform === "win32";
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(isWin ? "where" : "which", ["upstage"]);
    const resolved = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (!resolved) return { status: "warn", detail: "`upstage` not found on PATH" };
    return { status: "pass", detail: resolved };
  } catch {
    return { status: "warn", detail: "`upstage` not found on PATH" };
  }
}

function buildCoreSection() {
  return runSection("Core", [
    ["version", async () => `upstage-cli ${await readPackageVersion()}`],
    ["install type", () => {
      const info = detectInstallType();
      return { status: "pass", detail: info.type === "dev-link" ? `dev-link (${info.repoRoot})` : info.type };
    }],
    ["executable location", () => process.execPath],
    ["runtime", () => (globalThis.Bun?.version ? `Bun ${globalThis.Bun.version}` : `Node ${process.version}`)],
    ["platform", () => `${process.platform}/${process.arch}`],
    ["PATH", checkPathResolution]
  ]);
}

// ── Upstage ──────────────────────────────────────────────────────────────

function buildUpstageSection(settings) {
  return runSection("Upstage", [
    ["API key configured", () => {
      const keys = checkProviderKeys();
      return keys.upstage
        ? { status: "pass", detail: redactedKeyHint(process.env.UPSTAGE_API_KEY) }
        : { status: "warn", detail: "not configured (set UPSTAGE_API_KEY)" };
    }],
    // A genuine live call here (network round-trip against api.upstage.ai)
    // was deliberately scoped OUT of this check: doctor is meant to run
    // fast, offline-safe, and without side effects or cost, and a live
    // reachability probe is exactly what Task 7.U's `upstage auth test` is
    // for. Reporting "unknown" here (rather than fabricating a pass/fail
    // from a call we didn't make) is more honest than guessing.
    ["authentication valid / API reachable", () => {
      const keys = checkProviderKeys();
      if (!keys.upstage) return { status: "warn", detail: "no API key configured" };
      return { status: "unknown", detail: "not checked (doctor performs no live network calls — use `upstage auth test`)" };
    }],
    ["selected model", () => settings.model || "solar-pro4"],
    ["resolved context limits", () => {
      const caps = getModelCapabilities(settings.model);
      return `${caps.contextLimit.toLocaleString()} tokens`;
    }]
  ]);
}

// ── Project ──────────────────────────────────────────────────────────────

async function checkWorkspaceWritable(cwd) {
  try {
    await access(cwd, fsConstants.W_OK);
    return { status: "pass", detail: "writable" };
  } catch {
    return { status: "fail", detail: "not writable" };
  }
}

async function checkIntelligenceIndex(cwd) {
  const index = await loadIntelligenceIndexFromDisk(cwd);
  if (!index) return { status: "warn", detail: "no index built yet" };
  const health = getIndexHealth(index);
  return {
    status: "pass",
    detail: `${health.fileCount} files, ${health.symbolCount} symbols, parser=${health.parserMode}${health.fromCache ? " (cached)" : ""}`
  };
}

function buildProjectSection(cwd) {
  return runSection("Project", [
    ["cwd", () => cwd],
    ["git repo detection", () => (isGitRepo(cwd) ? { status: "pass", detail: "git repository" } : { status: "warn", detail: "not a git repository" })],
    ["workspace writable", () => checkWorkspaceWritable(cwd)],
    ["UPSTAGE.md presence", () => (existsSync(join(cwd, "UPSTAGE.md"))
      ? { status: "pass", detail: "present" }
      : { status: "warn", detail: "not found" })],
    ["intelligence index", () => checkIntelligenceIndex(cwd)],
    ["Tree-sitter parsers", () => {
      const languages = Object.keys(PARSERS);
      return { status: "pass", detail: `${languages.length} configured (${languages.join(", ")})` };
    }]
  ]);
}

// ── Extensions ───────────────────────────────────────────────────────────

async function gatherMcpStatus(cwd, settings) {
  const configs = await loadMcpServerConfigs(cwd, settings, { onLog: () => {} });
  const { servers, closeAll } = await connectConfiguredServers(configs, {
    cwd,
    timeoutMs: MCP_CHECK_TIMEOUT_MS,
    onLog: () => {}
  });
  const connectedNames = new Set(servers.map((s) => s.name));
  const failed = configs.map((c) => c.name).filter((n) => !connectedNames.has(n));

  // Only the mcp-sourced tool count is computed here — it's the one piece
  // of enrichment that's actually surfaced (in the "MCP servers" check
  // below) and directly related to what this function already connected
  // to. `createRegistryWithExtensions` also registers the ~43 builtin
  // tools as a side effect of building a registry at all, but that count
  // isn't reported by any check in this module, so it's deliberately not
  // extracted here — no point paying attention to a number nothing reads.
  let mcpToolCount = 0;
  if (servers.length > 0) {
    try {
      const registry = await createRegistryWithExtensions({
        policy: DEFAULT_POLICY,
        cwd,
        mcpServers: servers
      });
      mcpToolCount = registry.listActive({ source: "mcp" }).length;
    } catch {
      // Tool-count enrichment is best-effort; connection results above still stand.
    }
  }

  await closeAll().catch(() => {});

  return {
    configuredCount: configs.length,
    connectedCount: servers.length,
    failed,
    mcpToolCount
  };
}

function buildExtensionsSection(cwd, settings) {
  return runSection("Extensions", [
    ["skills", async () => {
      const loader = new SkillsLoader();
      await loader.load(cwd);
      const count = loader.list().length;
      return `${count} skill${count === 1 ? "" : "s"} loaded`;
    }],
    ["agents", async () => {
      const loader = new AgentLoader();
      await loader.load(cwd);
      const count = loader.list().length;
      return `${count} agent${count === 1 ? "" : "s"} loaded`;
    }],
    ["plugins", async () => {
      const loader = new PluginLoader();
      await loader.load(cwd);
      const count = loader.list().length;
      return `${count} plugin${count === 1 ? "" : "s"} loaded`;
    }],
    ["MCP servers", async () => {
      const status = await gatherMcpStatus(cwd, settings);
      if (status.configuredCount === 0) {
        return { status: "warn", detail: "no MCP servers configured" };
      }
      const detail = `${status.connectedCount}/${status.configuredCount} connected` +
        (status.connectedCount > 0 ? `; ${status.mcpToolCount} tool${status.mcpToolCount === 1 ? "" : "s"} available` : "") +
        (status.failed.length > 0 ? `; failed: ${status.failed.join(", ")}` : "");
      return { status: status.failed.length > 0 ? "warn" : "pass", detail };
    }],
    // Discovery invocation itself is intentionally NOT attempted here — it
    // would mean running an arbitrary external command inside a diagnostic
    // sweep, with its own (much longer) timeout budget. Presence-only is the
    // safe, bounded answer for `doctor`.
    ["discovered tools", () => {
      const configured = typeof process.env.UPSTAGE_DISCOVERY_COMMAND === "string" &&
        process.env.UPSTAGE_DISCOVERY_COMMAND.trim().length > 0;
      return {
        status: configured ? "pass" : "warn",
        detail: configured ? "discovery command configured (not invoked by doctor)" : "no discovery command configured"
      };
    }]
  ]);
}

// ── Security ─────────────────────────────────────────────────────────────

function buildSecuritySection(cwd, settings) {
  return runSection("Security", [
    ["permission mode", () => settings.permissions?.defaultMode || "default"],
    ["workspace boundary", () => `writes restricted to ${cwd} (PolicyEngine trustedWritePaths default)`],
    ["cost cap", () => {
      const maxCostUsd = settings.loopBudget?.maxCostUsd ?? DEFAULT_LOOP_BUDGET.maxCostUsd;
      return `$${maxCostUsd.toFixed(2)} per turn (DEFAULT_LOOP_BUDGET.maxCostUsd)`;
    }],
    ["PII protection", () => "enabled (Korean PII scan on write/network actions, PolicyEngine)"]
  ]);
}

// ── Verification ─────────────────────────────────────────────────────────

function buildVerificationSection(cwd) {
  // Shared across the three checks below rather than each calling
  // detectProjectCommands(cwd) independently — same package.json read,
  // parsed once.
  const detected = detectProjectCommands(cwd);
  return runSection("Verification", [
    ["detected lint command", async () => {
      const cmds = await detected;
      return cmds.lint
        ? { status: "pass", detail: `${cmds.lint.script}: ${cmds.lint.command}` }
        : { status: "warn", detail: "not detected" };
    }],
    ["detected typecheck command", async () => {
      const cmds = await detected;
      return cmds.typecheck
        ? { status: "pass", detail: `${cmds.typecheck.script}: ${cmds.typecheck.command}` }
        : { status: "warn", detail: "not detected" };
    }],
    ["detected test command", async () => {
      const cmds = await detected;
      return cmds.test
        ? { status: "pass", detail: `${cmds.test.script}: ${cmds.test.command}` }
        : { status: "warn", detail: "not detected" };
    }],
    // 3.3.0 Thread C, Task C.2 — never auto-downloads a browser, just
    // reports whether browser_* verification tools have one to use.
    ["browser (Chrome)", async () => {
      const chromePath = await findChrome();
      return chromePath
        ? { status: "pass", detail: chromePath }
        : { status: "warn", detail: "no Chrome/Chromium found — run `upstage browser install`, or install Chrome, to use browser_* verification tools" };
    }]
  ]);
}

// ── orchestration ────────────────────────────────────────────────────────

/**
 * Runs every section and returns `{ sections: [{ name, checks }] }`. Never
 * throws under normal operation — every check inside is individually caught
 * by `runCheck()`. Accepts an optional pre-loaded `settings`/`cwd` for tests.
 */
export async function runDoctorChecks({ cwd = process.cwd(), settings } = {}) {
  const resolvedSettings = settings || await loadSettings({ cwd });

  const sections = await Promise.all([
    buildCoreSection(),
    buildUpstageSection(resolvedSettings),
    buildProjectSection(cwd),
    buildExtensionsSection(cwd, resolvedSettings),
    buildSecuritySection(cwd, resolvedSettings),
    buildVerificationSection(cwd)
  ]);

  return { sections };
}

// ── formatting ───────────────────────────────────────────────────────────

const STATUS_GLYPH = {
  pass: "✓",
  warn: "!",
  fail: "✗",
  unknown: "?"
};

export function formatHuman(report) {
  const lines = [];
  for (const section of report.sections) {
    lines.push(`${section.name}`);
    for (const check of section.checks) {
      const glyph = STATUS_GLYPH[check.status] || "?";
      const detail = check.detail ? ` — ${check.detail}` : "";
      lines.push(`  [${glyph}] ${check.name}${detail}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

export function formatJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ── CLI entry point ─────────────────────────────────────────────────────

function printUsage() {
  process.stdout.write([
    "Usage: upstage doctor [--json]",
    "",
    "Runs a read-only diagnostic sweep (Core/Upstage/Project/Extensions/Security/Verification).",
    "Individual checks may report warn/fail — this never affects the command's own exit code."
  ].join("\n") + "\n");
}

/**
 * Router entry point. Always resolves to exit code 0 once the command has
 * run and produced a report — per Task 12.3's acceptance criteria, checks
 * reporting fail/warn are data, not a command failure. Only a genuinely
 * unexpected failure in the orchestration itself (which `runDoctorChecks`
 * is designed not to have, since every check is individually caught) would
 * cause a non-zero return here.
 */
export async function runDoctorCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }
  const jsonMode = rest.includes("--json");

  try {
    const report = await runDoctorChecks({ cwd: process.cwd() });
    process.stdout.write(jsonMode ? formatJson(report) : formatHuman(report));
    return 0;
  } catch (err) {
    // Should be unreachable in practice (every check is individually
    // caught by runCheck), but if the orchestration itself somehow throws
    // (e.g. Promise.all machinery), report it rather than crash silently.
    process.stderr.write(`upstage doctor: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
