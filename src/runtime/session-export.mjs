// Session export formatting — Task 7.13 of the 3.2.0 release plan (§7.L).
//
// Pure formatting logic over an already-loaded session object
// (`loadSession(id)` from src/runtime/session.mjs), deliberately kept out of
// session.mjs itself (which owns persistence, not presentation) per the
// plan's explicit file-split instruction.
//
// Three formats:
//   - json  — the (redacted, see below) session object as-is, pretty-printed
//   - jsonl — one JSON line per `history` entry, then one per `runtimeEvents`
//             entry, tagged with `_kind` — for streaming/log-processing tools
//   - md    — a human-readable transcript: conversation, applied patches,
//             verification results, token usage
//
// REDACTION (default, per §7.L / §8): session.mjs's own sanitizer
// (sanitizeValue) already bounds every string to 500 chars and every array
// to 20 items when an event is appended to `session.runtimeEvents` — but
// `session.toolResults` and the tool-call/tool-result entries embedded in
// `session.history` are stored RAW (see runtime/session.mjs's
// appendToolResult/appendHistory — neither sanitizes). For `write_file`
// (args.content) and `edit_file` (args.oldText/newText), that raw value is
// the full file body — the single most likely place a secret or a large
// chunk of proprietary source ends up in an exported artifact meant to be
// pasted into a bug report or shared with a teammate. So by default (unless
// `includeToolIo: true`) this module elides those fields — plus the mirrored
// `.preview` field tool results carry — to a short diff-stat-only summary,
// across all three places they can appear: `toolResults`, `history`, and
// `runtimeEvents`.

const REDACTED_HINT = "pass --include-tool-io to include";
const REDACTED_TOOLS = new Set(["write_file", "edit_file"]);

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lineCountOf(str) {
  return str.length === 0 ? 0 : str.split(/\r?\n/).length;
}

/** Replaces a raw string field (full file content, a diff hunk, a result
 *  preview) with a short diff-stat-only summary — never the content itself. */
function elideRawText(str, label) {
  if (typeof str !== "string") return str;
  const lines = lineCountOf(str);
  const bytes = Buffer.byteLength(str, "utf8");
  return `[${label} elided — ${lines} line${lines === 1 ? "" : "s"}, ${bytes} byte${bytes === 1 ? "" : "s"} — ${REDACTED_HINT}]`;
}

function elideArgsForTool(tool, args) {
  if (!args || typeof args !== "object") return args;
  const out = { ...args };
  if (tool === "write_file" && typeof out.content === "string") {
    out.content = elideRawText(out.content, "content");
  } else if (tool === "edit_file") {
    if (typeof out.oldText === "string") out.oldText = elideRawText(out.oldText, "oldText");
    if (typeof out.newText === "string") out.newText = elideRawText(out.newText, "newText");
  }
  return out;
}

/** `write_file`/`edit_file` results (and the runtimeEvents mirror of them)
 *  carry a `preview` field (a handful of lines around the write/edit) —
 *  small, but still raw file content, so it's elided the same way. */
function elideResultData(data) {
  if (!data || typeof data !== "object" || typeof data.preview !== "string") return data;
  return { ...data, preview: elideRawText(data.preview, "preview") };
}

function redactToolResultEntry(entry) {
  if (!entry || typeof entry !== "object" || !REDACTED_TOOLS.has(entry.tool)) return entry;
  const out = { ...entry, args: elideArgsForTool(entry.tool, entry.args) };
  if (entry.result && typeof entry.result === "object") {
    const result = { ...entry.result };
    if (result.data) result.data = elideResultData(result.data);
    out.result = result;
  }
  return out;
}

function redactHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;

  if (entry.role === "assistant" && Array.isArray(entry.tool_calls)) {
    let changed = false;
    const tool_calls = entry.tool_calls.map((tc) => {
      const name = tc?.function?.name;
      if (!REDACTED_TOOLS.has(name)) return tc;
      changed = true;
      const parsedArgs = safeJsonParse(tc.function.arguments) || {};
      const redactedArgs = elideArgsForTool(name, parsedArgs);
      return { ...tc, function: { ...tc.function, arguments: JSON.stringify(redactedArgs) } };
    });
    return changed ? { ...entry, tool_calls } : entry;
  }

  if (entry.role === "tool" && REDACTED_TOOLS.has(entry.name)) {
    const parsed = safeJsonParse(entry.content);
    if (parsed && typeof parsed === "object") {
      return { ...entry, content: JSON.stringify(elideResultData(parsed)) };
    }
  }

  return entry;
}

function redactRuntimeEventEntry(entry) {
  if (!entry || typeof entry !== "object" || !REDACTED_TOOLS.has(entry.tool)) return entry;
  if (entry.type === "tool_start") {
    return { ...entry, args: elideArgsForTool(entry.tool, entry.args) };
  }
  if (entry.type === "tool_result") {
    return { ...entry, result: elideResultData(entry.result) };
  }
  return entry;
}

/**
 * Redacts raw write_file/edit_file file bodies out of a session's
 * `toolResults`, `history`, and `runtimeEvents` — see this file's header.
 * Returns a new object; never mutates `session`.
 */
export function redactSessionToolIo(session) {
  if (!session || typeof session !== "object") return session;
  const out = { ...session };
  if (Array.isArray(session.toolResults)) {
    out.toolResults = session.toolResults.map(redactToolResultEntry);
  }
  if (Array.isArray(session.history)) {
    out.history = session.history.map(redactHistoryEntry);
  }
  if (Array.isArray(session.runtimeEvents)) {
    out.runtimeEvents = session.runtimeEvents.map(redactRuntimeEventEntry);
  }
  return out;
}

function prepareSession(session, { includeToolIo = false } = {}) {
  return includeToolIo ? session : redactSessionToolIo(session);
}

// ── json ─────────────────────────────────────────────────────────────────

/** The (redacted, by default) session object as-is, pretty-printed. */
export function formatSessionAsJson(session, opts = {}) {
  return `${JSON.stringify(prepareSession(session, opts), null, 2)}\n`;
}

// ── jsonl ────────────────────────────────────────────────────────────────

/** One JSON line per `history` entry, then one per `runtimeEvents` entry —
 *  each tagged with `_kind` so a streaming/log-processing consumer can tell
 *  the two apart without inspecting shape. */
export function formatSessionAsJsonl(session, opts = {}) {
  const prepared = prepareSession(session, opts);
  const lines = [];
  for (const item of prepared.history || []) {
    lines.push(JSON.stringify({ _kind: "history", ...item }));
  }
  for (const item of prepared.runtimeEvents || []) {
    lines.push(JSON.stringify({ _kind: "runtimeEvent", ...item }));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// ── md ───────────────────────────────────────────────────────────────────

function renderHistoryEntry(item) {
  if (!item || typeof item !== "object") return [];
  if (item.role === "user") {
    const content = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
    return ["### User", "", content, ""];
  }
  if (item.role === "assistant") {
    const lines = ["### Assistant", ""];
    if (item.content) lines.push(item.content, "");
    for (const tc of item.tool_calls || []) {
      const name = tc?.function?.name || "unknown";
      const args = safeJsonParse(tc?.function?.arguments) ?? {};
      lines.push(`→ called \`${name}\`(${JSON.stringify(args)})`, "");
    }
    return lines;
  }
  if (item.role === "tool") {
    const data = safeJsonParse(item.content);
    return [
      `### Tool Result: ${item.name || "unknown"}`,
      "",
      "```json",
      JSON.stringify(data ?? item.content, null, 2),
      "```",
      ""
    ];
  }
  return [];
}

function renderAppliedPatches(patches) {
  if (!Array.isArray(patches) || patches.length === 0) return [];
  const lines = ["## Applied Patches", ""];
  for (const p of patches) {
    const when = p?.at ? new Date(p.at).toISOString() : "unknown time";
    const verified = p?.verified === true ? "yes" : p?.verified === false ? "no" : "unknown";
    lines.push(`- ${p?.path || "(unknown path)"} — verified: ${verified} (${when})`);
  }
  lines.push("");
  return lines;
}

function renderVerification(events) {
  const items = (events || []).filter((e) => e?.type === "verify_start" || e?.type === "verify_end");
  if (items.length === 0) return [];
  const lines = ["## Verification", ""];
  for (const e of items) {
    const { type, at, timestamp, ...rest } = e;
    lines.push(`- **${type}**: ${JSON.stringify(rest)}`);
  }
  lines.push("");
  return lines;
}

function renderTokenUsage(events) {
  const items = (events || []).filter((e) => e?.type === "token_usage");
  if (items.length === 0) return [];
  const last = items[items.length - 1];
  const { type, at, timestamp, ...rest } = last;
  return ["## Token Usage", "", "```json", JSON.stringify(rest, null, 2), "```", ""];
}

/** A human-readable transcript: conversation (prompts/responses/tool calls),
 *  applied patches, verification results, token usage — see this file's
 *  header for the redaction default applied to tool call args/results. */
export function formatSessionAsMarkdown(session, opts = {}) {
  const prepared = prepareSession(session, opts);
  const lines = [];

  lines.push(`# Session ${prepared.id || "(unknown id)"}`, "");
  lines.push(`- Created: ${prepared.createdAt ? new Date(prepared.createdAt).toISOString() : "unknown"}`);
  lines.push(`- Updated: ${prepared.updatedAt ? new Date(prepared.updatedAt).toISOString() : "unknown"}`);
  lines.push(`- Workspace: ${prepared.workspace?.cwd || "(unknown)"}`);
  if (prepared.parentSessionId) lines.push(`- Forked from: ${prepared.parentSessionId}`);
  lines.push("");

  const history = Array.isArray(prepared.history) ? prepared.history : [];
  if (history.length > 0) {
    lines.push("## Conversation", "");
    for (const item of history) lines.push(...renderHistoryEntry(item));
  }

  lines.push(...renderAppliedPatches(prepared.appliedPatches));
  lines.push(...renderVerification(prepared.runtimeEvents));
  lines.push(...renderTokenUsage(prepared.runtimeEvents));

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
