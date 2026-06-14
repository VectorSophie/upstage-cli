import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { validatePath } from "../permissions/path-check.mjs";

/**
 * `@file` mentions — resolve `@path/to/file` tokens in a prompt into file
 * content that gets injected as context (like Claude Code's @-references).
 *
 * Only files inside `cwd` are read (via the path validator), each capped to
 * `maxBytes`. Mentions that don't resolve are reported but never throw.
 */

const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;
const DEFAULT_MAX_BYTES = 64 * 1024;

/** Extract candidate path tokens from `@...` mentions (deduped, order-preserving). */
export function extractMentions(text) {
  if (typeof text !== "string") return [];
  const seen = new Set();
  const out = [];
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    let token = m[1];
    // Drop trailing punctuation that's unlikely to be part of a path.
    token = token.replace(/[),.;:]+$/, "");
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Resolve mentions to file contents. Returns:
 *   { mentions: [{ path, ok, bytes?, content?, error? }], contextBlock }
 * `contextBlock` is a ready-to-append string (empty if nothing resolved).
 */
export async function resolveMentions(text, cwd = process.cwd(), { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const tokens = extractMentions(text);
  const mentions = [];
  const root = resolve(cwd);
  for (const token of tokens) {
    const abs = resolve(root, token);
    // Strict containment: the resolved path must live inside cwd.
    if (abs !== root && !abs.startsWith(root + sep)) {
      mentions.push({ path: token, ok: false, error: "outside workspace" });
      continue;
    }
    // Block sensitive files (.env, keys, …) even when inside cwd.
    const check = validatePath(abs, { write: false, cwd: root });
    if (!check.safe) {
      mentions.push({ path: token, ok: false, error: check.reason || "blocked" });
      continue;
    }
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        mentions.push({ path: token, ok: false, error: "not a file" });
        continue;
      }
      let content = await readFile(abs, "utf8");
      let bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxBytes) {
        content = content.slice(0, maxBytes);
        content += `\n… [truncated, ${bytes} bytes total]`;
        bytes = maxBytes;
      }
      mentions.push({ path: token, ok: true, bytes, content });
    } catch {
      mentions.push({ path: token, ok: false, error: "not found" });
    }
  }

  const resolved = mentions.filter((m) => m.ok);
  let contextBlock = "";
  if (resolved.length > 0) {
    contextBlock = "Referenced files:\n\n" +
      resolved.map((m) => `--- ${m.path} ---\n${m.content}`).join("\n\n");
  }
  return { mentions, contextBlock };
}
