/**
 * Composer autocomplete — pure logic for the input box.
 * Produces slash-command (`/`) and file-mention (`@`) suggestions for the
 * current input, with the span to replace on accept. No React, fully testable.
 */

function fuzzyRank(items, query, keyFn) {
  const q = query.toLowerCase();
  if (!q) return items;
  return items
    .map((it) => {
      const key = keyFn(it).toLowerCase();
      let score = -1;
      // Prefix matches all rank equally (stable sort preserves input order);
      // substring matches rank below, earlier position first.
      if (key.startsWith(q)) score = 100;
      else if (key.includes(q)) score = 50 - key.indexOf(q);
      return { it, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it);
}

/**
 * @param {string} text       full composer text
 * @param {object} opts       { commands: [{name, description}], files: [string], limit }
 * @returns {null | { mode, query, token, start, end, items }}
 *   start/end delimit the text span the accepted value should replace.
 */
export function getAutocomplete(text, { commands = [], files = [], limit = 8 } = {}) {
  if (typeof text !== "string") return null;

  // Slash commands: only when the line *starts* with '/' and has no space yet.
  if (text.startsWith("/") && !/\s/.test(text)) {
    const query = text.slice(1);
    const items = fuzzyRank(commands, query, (c) => c.name.replace(/^\//, "")).slice(0, limit);
    if (items.length === 0) return null;
    return { mode: "command", query, token: text, start: 0, end: text.length, items };
  }

  // File mentions: the last whitespace-delimited token beginning with '@'.
  const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
  const token = text.slice(lastSpace + 1);
  if (token.startsWith("@")) {
    const query = token.slice(1);
    const items = fuzzyRank(files.map((f) => ({ path: f })), query, (f) => f.path)
      .slice(0, limit)
      .map((f) => f.path);
    if (items.length === 0) return null;
    return { mode: "file", query, token, start: lastSpace + 1, end: text.length, items };
  }

  return null;
}

/** Apply an accepted suggestion, returning the new composer text. */
export function applyCompletion(text, completion) {
  if (!completion) return text;
  const value = completion.mode === "file" ? `@${completion.value}` : completion.value;
  return text.slice(0, completion.start) + value + (completion.suffix || " ");
}
