import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCheckpoints, restoreCheckpoint, checkpointsDir } from "../src/core/rewind.mjs";
import { CheckpointManager } from "../src/core/checkpoints.mjs";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  const base = join(dir, ".upstage", "checkpoints");
  await mkdir(base, { recursive: true });
  return { dir, base };
}

test("checkpointsDir resolves under .upstage/checkpoints", () => {
  assert.match(checkpointsDir("/tmp/x"), /[\\/]\.upstage[\\/]checkpoints$/);
});

test("lists checkpoints newest-first and restores a reverted file", async () => {
  const { dir, base } = await setup();
  try {
    const file = join(dir, "src.txt");
    await writeFile(file, "ORIGINAL");

    // CheckpointManager snapshots the pre-edit content.
    const cm = new CheckpointManager(base);
    await cm.save(file);
    // Now the agent "edits" the file.
    await writeFile(file, "EDITED");

    const list = await listCheckpoints(base);
    assert.equal(list.length, 1);
    assert.equal(list[0].relativePath.includes("src.txt"), true);

    const res = await restoreCheckpoint(base, list[0].id);
    assert.equal(res.ok, true);
    assert.equal(res.action, "reverted");
    assert.equal(await readFile(file, "utf8"), "ORIGINAL");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("restoring a checkpoint of a previously-new file deletes it", async () => {
  const { dir, base } = await setup();
  try {
    const file = join(dir, "created.txt");
    const cm = new CheckpointManager(base); // file does not exist yet → content null
    await cm.save(file);
    await writeFile(file, "NOW EXISTS");

    const res = await restoreCheckpoint(base); // no id → latest
    assert.equal(res.ok, true);
    assert.equal(res.action, "deleted");
    assert.equal(existsSync(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("restore with an unknown id reports an error", async () => {
  const { dir, base } = await setup();
  try {
    const res = await restoreCheckpoint(base, "ckpt_does_not_exist");
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
