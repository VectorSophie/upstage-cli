import { watch } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Watch mode (docs/feature-landscape-2026.md §3.3, Aider's file-comment
 * trigger): the file becomes the prompt entry point instead of the
 * terminal — drop `// ai! <instruction>` in a file and save, and the agent
 * picks it up. Inverse of our existing `@file` mentions
 * (src/agent/file-mentions.mjs), which pull a file *into* a prompt.
 */

// Matches Aider's own convention (`# ai!`, `// ai?`) across comment styles;
// `!` = act now, `?` = a question, both trigger — the distinction is left
// for the model to read from the marker itself, not enforced here.
const MARKER_PATTERN = /(?:\/\/|#|--)\s*ai([!?])\s*(.*)$/i;
const IGNORED_SEGMENTS = ["node_modules", ".git", ".upstage", "dist", "build"];

export function findAiMarkers(content) {
  if (typeof content !== "string") return [];
  return content
    .split("\n")
    .map((line, i) => {
      const m = line.match(MARKER_PATTERN);
      return m ? { lineNumber: i + 1, line: line.trim(), urgent: m[1] === "!", note: m[2].trim() } : null;
    })
    .filter(Boolean);
}

function isIgnoredSegment(name) {
  return IGNORED_SEGMENTS.includes(name);
}

// `fs.watch(dir, { recursive: true })` has to enumerate the *entire*
// subtree before it can even start watching — pointed at a real project
// root that has node_modules under it, that's tens of thousands of
// entries, and it blocks (confirmed empirically: launching watch mode on
// this repo's own cwd never returned). So this walks the tree itself,
// skipping node_modules/.git/etc. *before* calling fs.watch, and watches
// each qualifying directory individually (non-recursive) instead of one
// recursive call on the root.
// ponytail: directories created *after* watch mode starts aren't picked
// up — rescanning on every 'rename' event to catch new directories is a
// reasonable v2, not done here since it adds real complexity for a case
// (mid-session new subdirectories) that's uncommon for what this feature
// is actually for (editing existing files).
// Calls `onDir(dir)` for each qualifying directory as it's *found*, not
// after the whole walk finishes — the root (most likely to matter, and
// where the very first test of this found the bug: the root wasn't
// watched until the entire repo tree had been walked) gets watched
// immediately, subdirectories as the BFS reaches them.
async function walkWatchDirs(root, onDir) {
  onDir(root);
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable/removed mid-scan
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isIgnoredSegment(entry.name)) continue;
      const full = join(dir, entry.name);
      onDir(full);
      queue.push(full);
    }
  }
}

/**
 * Watches `cwd` for saved files containing an AI marker comment and calls
 * `onTrigger({ path, relativePath, markers, content })` once per distinct
 * marker state (debounced, and de-duplicated so re-saving the same file
 * without changing the marker doesn't refire — including our own edit of
 * the file in response, which would otherwise retrigger itself).
 */
export function createWatcher({ cwd = process.cwd(), onTrigger, debounceMs = 500 } = {}) {
  const lastMarkerState = new Map(); // absolute path -> serialized marker state
  const timers = new Map();
  const watchers = [];
  let closed = false;

  const handleEvent = (dir, filename) => {
    if (!filename) return;
    const fullPath = join(dir, filename);
    const key = fullPath;

    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(async () => {
        timers.delete(key);
        let content;
        try {
          content = await readFile(fullPath, "utf8");
        } catch {
          lastMarkerState.delete(fullPath);
          return; // deleted or unreadable mid-event
        }

        const markers = findAiMarkers(content);
        if (markers.length === 0) {
          lastMarkerState.delete(fullPath);
          return;
        }

        const state = markers.map((m) => `${m.lineNumber}:${m.note}`).join("|");
        if (lastMarkerState.get(fullPath) === state) return;
        lastMarkerState.set(fullPath, state);

        onTrigger({ path: fullPath, relativePath: relative(cwd, fullPath), markers, content });
      }, debounceMs)
    );
  };

  // Directory collection is async; watchers attach as each directory is
  // found (root first) rather than waiting for the whole tree, so watch
  // mode covers the root — the common case — immediately.
  //
  // Verified against real fs.watch behavior under both Node and Bun (this
  // project's actual runtime), not assumed: Bun's fs.watch — recursive or
  // not — unreliably detects brand-new file *creation*, but reliably fires
  // on *modification* of an already-existing file (confirmed with an
  // isolated createWatcher() test: appending a marker to an existing file
  // triggered onTrigger correctly end-to-end). That matches this feature's
  // actual use case — dropping a marker comment into a file you're already
  // editing, Aider's own convention — not creating a file from scratch.
  walkWatchDirs(cwd, (dir) => {
    if (closed) return;
    try {
      watchers.push(watch(dir, { recursive: false }, (_eventType, filename) => handleEvent(dir, filename)));
    } catch {
      // directory removed between scan and watch, or platform limit — skip it
    }
  }).catch(() => {});

  return {
    close() {
      closed = true;
      for (const w of watchers) w.close();
      watchers.length = 0;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    }
  };
}

/** Build a prompt from a trigger event — one message per file, all its markers included. */
export function buildWatchPrompt({ relativePath, markers }) {
  const lines = markers.map((m) => `  Line ${m.lineNumber}: ${m.line}${m.note ? ` — ${m.note}` : ""}`);
  return `[watch mode] ${relativePath} was saved with an AI marker:\n${lines.join("\n")}\n\nRead the file and act on the marker(s), then remove the marker comment(s) once handled.`;
}
