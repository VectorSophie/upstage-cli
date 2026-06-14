import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * File-level rewind over the on-disk checkpoints written by CheckpointManager
 * (`.upstage/checkpoints/*.json`). Each checkpoint captures one file's content
 * *before* an edit, so restoring one reverts that file to its pre-edit state.
 *
 * This reads from disk (not the in-memory CheckpointManager.history), so it
 * works across the whole session, not just the current run.
 */

export function checkpointsDir(cwd = process.cwd()) {
  return join(cwd, ".upstage", "checkpoints");
}

/** Newest-first list of checkpoints: { id, relativePath, filePath, timestamp, isNew, size }. */
export async function listCheckpoints(baseDir = checkpointsDir(), limit = 20) {
  if (!existsSync(baseDir)) return [];
  let files;
  try {
    files = await readdir(baseDir);
  } catch {
    return [];
  }
  const records = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await readFile(join(baseDir, f), "utf8"));
      records.push({
        id: rec.id,
        relativePath: rec.relativePath || rec.filePath,
        filePath: rec.filePath,
        timestamp: rec.timestamp || 0,
        isNew: rec.content === null,
        size: rec.size || 0
      });
    } catch {
      // skip unreadable checkpoint
    }
  }
  records.sort((a, b) => b.timestamp - a.timestamp);
  return records.slice(0, limit);
}

/**
 * Restore a checkpoint by id (or, when `id` is omitted, the most recent one).
 * Reverts the file to its captured content, or deletes it if it was new.
 * Returns { ok, id, relativePath, action } or { ok: false, error }.
 */
export async function restoreCheckpoint(baseDir = checkpointsDir(), id = null) {
  if (!existsSync(baseDir)) return { ok: false, error: "no checkpoints found" };

  let targetFile = null;
  if (id) {
    const candidate = join(baseDir, `${id}.json`);
    if (existsSync(candidate)) targetFile = candidate;
  } else {
    const list = await listCheckpoints(baseDir, 1);
    if (list.length > 0) targetFile = join(baseDir, `${list[0].id}.json`);
  }
  if (!targetFile) return { ok: false, error: `checkpoint not found: ${id || "(latest)"}` };

  let rec;
  try {
    rec = JSON.parse(await readFile(targetFile, "utf8"));
  } catch (err) {
    return { ok: false, error: `unreadable checkpoint: ${err.message}` };
  }

  let action;
  if (rec.content === null) {
    // File did not exist before the edit — remove it to restore the prior state.
    try { await unlink(rec.filePath); } catch { /* already gone */ }
    action = "deleted";
  } else {
    await writeFile(rec.filePath, rec.content, "utf8");
    action = "reverted";
  }
  return { ok: true, id: rec.id, relativePath: rec.relativePath || rec.filePath, action };
}
