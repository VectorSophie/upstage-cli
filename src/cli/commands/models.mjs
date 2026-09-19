// `upstage models list/info` — Task 7.16 of the 3.2.0 release plan.
//
// listModelCapabilities()/getModelInfo() are the single source of truth for
// per-model capability data this command AND the TUI's `/model` handler
// (src/ui/commands.mjs) both call — deliberately not reimplemented there,
// so the two can never drift (see this file's tests, and
// tests/m33-models-cli.test.mjs's dedicated "/model matches `models info`"
// assertion). Both functions are pure, synchronous reads of the in-memory
// model-capabilities.mjs table — no network call, no failure mode beyond a
// bad `id` (see the acceptance/failure-mode notes in the release plan).

import { getModelCapabilities, KNOWN_MODEL_IDS } from "../../model/model-capabilities.mjs";
import { getProvider } from "../../core/providers.mjs";

// Mirrors upstage-adapter.mjs's own DEFAULT_MODEL resolution
// (`process.env.UPSTAGE_MODEL || "solar-pro4"`) exactly, rather than the
// full settings.json cascade — this is what actually determines which
// model a bare `new UpstageAdapter()` (no explicit `model` option) talks
// to, which is the sense of "default" `isDefault` below reports. Read
// fresh on every call (not cached at module load) so it responds to
// UPSTAGE_MODEL changing between calls, e.g. across tests.
function resolveDefaultModelId() {
  return process.env.UPSTAGE_MODEL || "solar-pro4";
}

function toRow(id) {
  const caps = getModelCapabilities(id);
  return {
    id,
    provider: getProvider(id).id,
    contextLimit: caps.contextLimit,
    supportsReasoningEffort: caps.supportsReasoningEffort,
    supportsParallelToolCalls: caps.supportsParallelToolCalls,
    supportsResponseFormat: caps.supportsResponseFormat,
    isDefault: id === resolveDefaultModelId()
  };
}

/** Returns `[{id, provider, contextLimit, supportsReasoningEffort,
 *  supportsParallelToolCalls, supportsResponseFormat, isDefault}]` — one row
 *  per model-capabilities.mjs's KNOWN_MODEL_IDS, in that table's order. */
export function listModelCapabilities() {
  return KNOWN_MODEL_IDS.map(toRow);
}

/** Returns one row (same shape as a `listModelCapabilities()` element) for
 *  `id`, or throws a clear "unknown model" Error naming the known ids —
 *  never a silent fallback (unlike getModelCapabilities() itself, whose
 *  fallback-to-Pro2 behavior is right for its own callers but wrong here:
 *  presenting Pro2's numbers as if they were solar-mini's real capabilities
 *  would be actively misleading in an introspection command). Case-
 *  insensitive, matching getModelCapabilities()'s own normalization. */
export function getModelInfo(id) {
  const normalized = typeof id === "string" ? id.toLowerCase() : "";
  if (!KNOWN_MODEL_IDS.includes(normalized)) {
    throw new Error(`Unknown model: "${id}". Known models: ${KNOWN_MODEL_IDS.join(", ")}`);
  }
  return toRow(normalized);
}

// ── formatting ───────────────────────────────────────────────────────────

function checkmark(value) {
  return value ? "yes" : "no";
}

export function formatModelListHuman(rows) {
  if (rows.length === 0) return "No known models.\n";
  const header = ["ID", "PROVIDER", "CONTEXT", "REASONING", "PARALLEL", "RESP_FORMAT", "DEFAULT"];
  const data = rows.map((r) => [
    r.id,
    r.provider,
    String(r.contextLimit),
    checkmark(r.supportsReasoningEffort),
    checkmark(r.supportsParallelToolCalls),
    checkmark(r.supportsResponseFormat),
    checkmark(r.isDefault)
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmtRow(header), ...data.map(fmtRow)].join("\n") + "\n";
}

export function formatModelListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** Shared by `models info` and the TUI's `/model` handler (src/ui/
 *  commands.mjs) — the literal function the "same function, no drift"
 *  requirement (Task 7.16's acceptance criteria) refers to. */
export function formatModelInfoHuman(row) {
  return [
    `id: ${row.id}`,
    `provider: ${row.provider}`,
    `contextLimit: ${row.contextLimit}`,
    `supportsReasoningEffort: ${row.supportsReasoningEffort}`,
    `supportsParallelToolCalls: ${row.supportsParallelToolCalls}`,
    `supportsResponseFormat: ${row.supportsResponseFormat}`,
    `isDefault: ${row.isDefault}`
  ].join("\n") + "\n";
}

export function formatModelInfoJson(row) {
  return `${JSON.stringify(row, null, 2)}\n`;
}

// ── CLI entry points ────────────────────────────────────────────────────

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage models list [--json]",
      "",
      "Lists every model this build has real capability data for (see",
      "src/model/model-capabilities.mjs), with context limit and support flags",
      "for reasoning-effort/parallel-tool-calls/response-format.",
      "",
      "Options:",
      "  --json   Output as JSON: [{id, provider, contextLimit,",
      "           supportsReasoningEffort, supportsParallelToolCalls,",
      "           supportsResponseFormat, isDefault}]"
    ].join("\n") + "\n"
  );
}

export async function runModelsListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const json = rest.includes("--json");
  const rows = listModelCapabilities();
  process.stdout.write(json ? formatModelListJson(rows) : formatModelListHuman(rows));
  return 0;
}

function printInfoUsage() {
  process.stdout.write(
    [
      "Usage: upstage models info <model> [--json]",
      "",
      "  Prints one model's capability row (same data/format `/model` shows",
      "  in the TUI for the active model).",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

export async function runModelsInfoCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printInfoUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const id = positionals[0];
  if (!id) {
    process.stderr.write("upstage models info: missing required <model> argument\n");
    return 2;
  }
  let row;
  try {
    row = getModelInfo(id);
  } catch (err) {
    process.stderr.write(`upstage models info: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  process.stdout.write(json ? formatModelInfoJson(row) : formatModelInfoHuman(row));
  return 0;
}
