// `upstage auth status/test` — Task 12.8 of the 3.2.0 release plan (§7.U
// design detail).
//
// `status` reports, per configured provider (src/core/providers.mjs's
// PROVIDERS registry): which env var is set (`Source`, reusing
// `checkProviderKeys()`'s presence booleans), whether a key is configured
// (`Key`: 'configured'/'not configured' — NEVER the value), and, for the
// active provider only (src/core/providers.mjs's `getProvider(model)`), one
// lightweight live reachability call. `test` forces that same live check for
// a named provider regardless of which is "active".
//
// SECURITY: this module never reads an env var's VALUE for display — only
// `Boolean(process.env[X])` (via `checkProviderKeys()`) to decide
// configured/not-configured, and the var NAME itself (a constant from the
// PROVIDERS table, not attacker/user-controlled) to show as `Source`. See
// m33-auth-cli.test.mjs's dedicated adversarial test (a fake key value must
// never appear anywhere in human or JSON output).
//
// LIVE CHECK SCOPE: a real HTTP client already exists for Upstage
// (src/upstage/client.mjs's `upstageRequest`, Task 7.1) — reused here for a
// minimal `max_tokens: 1` chat-completions call, bounded by
// LIVE_CHECK_TIMEOUT_MS so a network hang can never hang this command.
// openai/gemini/openrouter have NO existing HTTP client in this codebase
// (only their provider metadata — endpoint URL, env var names — is known);
// building three new provider-specific HTTP clients is out of this task's
// scope (see the release plan's own note to this effect), so those report
// `not checked (Upstage only)` rather than a fabricated pass/fail.
//
// MISSING vs. UNREACHABLE: these are deliberately distinct outcomes, never
// conflated — `not-configured` (no key at all, no network call attempted)
// vs. `unreachable` (a key exists, the live call was attempted and failed).
// `checkReachability` is injectable on every exported gather* function so
// tests can mock the live call instead of hitting the network.

import { checkProviderKeys, listProviders, getProvider, getProviderByName } from "../../core/providers.mjs";
import { loadSettings } from "../../config/settings.mjs";
import { upstageRequest } from "../../upstage/client.mjs";

// Short — an auth check must never hang the command on a slow/unreachable
// endpoint. Same order of magnitude as doctor.mjs's/mcp.mjs's own connect
// timeouts, for the same reason.
const LIVE_CHECK_TIMEOUT_MS = 5000;

// ── reachability ─────────────────────────────────────────────────────────

/** The ONLY function in this module that makes a network call. A minimal
 *  chat-completions request (`max_tokens: 1`) — cheap, but a genuine
 *  round-trip against the real endpoint, which is what "reachable" is
 *  supposed to mean. Never called when no API key is configured (callers
 *  check that first) — a missing key must never be reported as
 *  "unreachable". */
export async function defaultCheckUpstageReachability({ apiKey, model, timeoutMs = LIVE_CHECK_TIMEOUT_MS } = {}) {
  try {
    await upstageRequest({
      path: "/chat/completions",
      method: "POST",
      body: { model: model || "solar-pro4", messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      apiKey,
      timeoutMs
    });
    return { status: "reachable", detail: "API reachable" };
  } catch (err) {
    return { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Which env var name is actually set for this provider (never the value) —
 *  falls back to the provider's primary `envKey` name (still just a name,
 *  telling the user what to set) when neither is set. */
function resolveEnvSource(provider) {
  if (process.env[provider.envKey]) return provider.envKey;
  if (provider.altEnvKey && process.env[provider.altEnvKey]) return provider.altEnvKey;
  return provider.envKey;
}

async function resolveApiCheck({ provider, configured, checkReachability, model }) {
  if (provider.id !== "upstage") {
    return { status: "not-checked", detail: "not checked (Upstage only)" };
  }
  if (!configured) {
    return { status: "not-configured", detail: "no API key configured" };
  }
  return checkReachability({ apiKey: process.env.UPSTAGE_API_KEY, model });
}

// ── status ───────────────────────────────────────────────────────────────

/** Returns `{ rows: [{id, name, source, key, active}], activeProviderId,
 *  apiCheck: {status, detail} }`. `apiCheck` reflects the ACTIVE provider
 *  only — one live call at most, and only when that provider is Upstage and
 *  a key is configured (see resolveApiCheck above). */
export async function gatherAuthStatus({
  cwd = process.cwd(),
  settings,
  checkReachability = defaultCheckUpstageReachability
} = {}) {
  const resolvedSettings = settings || (await loadSettings({ cwd }));
  const keys = checkProviderKeys();
  const active = getProvider(resolvedSettings.model);

  const rows = listProviders().map((provider) => {
    const configured = Boolean(keys[provider.id]);
    return {
      id: provider.id,
      name: provider.name,
      source: resolveEnvSource(provider),
      key: configured ? "configured" : "not configured",
      active: provider.id === active.id
    };
  });

  const activeRow = rows.find((r) => r.active);
  const apiCheck = await resolveApiCheck({
    provider: active,
    configured: activeRow?.key === "configured",
    checkReachability,
    model: resolvedSettings.model
  });

  return { rows, activeProviderId: active.id, apiCheck };
}

export function formatAuthStatusHuman(report) {
  const header = ["PROVIDER", "SOURCE", "KEY", "ACTIVE"];
  const data = report.rows.map((r) => [r.name, r.source, r.key, r.active ? "yes" : "no"]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [fmtRow(header), ...data.map(fmtRow), "", `API: ${report.apiCheck.detail}`];
  return lines.join("\n") + "\n";
}

export function formatAuthStatusJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function printStatusUsage() {
  process.stdout.write(
    [
      "Usage: upstage auth status [--json]",
      "",
      "Prints, per provider: Source (which env var is set), Key",
      "(configured/not configured — never the value), and which provider is",
      "active. For the active provider only, performs one lightweight live",
      "reachability call (Upstage only — other providers report",
      "'not checked').",
      "",
      "Options:",
      "  --json   Output as JSON: {rows, activeProviderId, apiCheck}"
    ].join("\n") + "\n"
  );
}

/** Always exits 0 once it has run and produced a report — same philosophy
 *  as `doctor`: an individual provider being unconfigured, or the active
 *  provider being unreachable, is DATA, not a command failure. */
export async function runAuthStatusCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printStatusUsage();
    return 0;
  }
  const json = rest.includes("--json");
  const report = await gatherAuthStatus({ cwd: process.cwd() });
  process.stdout.write(json ? formatAuthStatusJson(report) : formatAuthStatusHuman(report));
  return 0;
}

// ── test ─────────────────────────────────────────────────────────────────

/** Forces the live reachability check for ONE named provider, regardless of
 *  which provider is "active". Returns `{ result: {provider, source, key,
 *  api} }` or `{ error, code }` (2 = unknown/missing provider name). */
export async function gatherAuthTest({
  cwd = process.cwd(),
  settings,
  provider: providerName,
  checkReachability = defaultCheckUpstageReachability
} = {}) {
  if (!providerName) return { error: "missing required <provider> argument", code: 2 };
  const provider = getProviderByName(providerName);
  if (!provider) return { error: `unknown provider: '${providerName}'`, code: 2 };

  const resolvedSettings = settings || (await loadSettings({ cwd }));
  const keys = checkProviderKeys();
  const configured = Boolean(keys[provider.id]);

  const api = await resolveApiCheck({ provider, configured, checkReachability, model: resolvedSettings.model });

  return {
    result: {
      provider: provider.id,
      source: resolveEnvSource(provider),
      key: configured ? "configured" : "not configured",
      api
    }
  };
}

/** Maps an `api.status` to `test`'s exit code: 0 = reachable or a
 *  deliberately-unimplemented provider (not-checked is data, not failure),
 *  3 = upstream API error (unreachable), 4 = missing/invalid config
 *  (not-configured) — per this codebase's CLI exit-code convention. */
function exitCodeForApiStatus(status) {
  if (status === "unreachable") return 3;
  if (status === "not-configured") return 4;
  return 0;
}

export function formatAuthTestHuman(result) {
  const lines = [
    `provider: ${result.provider}`,
    `source: ${result.source}`,
    `key: ${result.key}`,
    `api: ${result.api.status} — ${result.api.detail}`
  ];
  return lines.join("\n") + "\n";
}

export function formatAuthTestJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function printTestUsage() {
  process.stdout.write(
    [
      "Usage: upstage auth test <provider> [--json]",
      "",
      "Forces the live reachability check for one named provider (upstage |",
      "openai | gemini | openrouter), regardless of which is currently",
      "active. Only 'upstage' has a real live check in this build — other",
      "providers report api.status = 'not-checked'.",
      "",
      "Options:",
      "  --json   Output as JSON: {provider, source, key, api}"
    ].join("\n") + "\n"
  );
}

export async function runAuthTestCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printTestUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const provider = positionals[0];

  const outcome = await gatherAuthTest({ cwd: process.cwd(), provider });
  if (outcome.error) {
    process.stderr.write(`upstage auth test: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatAuthTestJson(outcome.result) : formatAuthTestHuman(outcome.result));
  return exitCodeForApiStatus(outcome.result.api.status);
}
