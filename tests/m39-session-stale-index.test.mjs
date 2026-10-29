// loadLatestSession must survive a stale session index: the index is a cache
// updated by read-modify-write, so concurrent processes can leave an entry
// whose session file no longer exists. Before the fix this threw ENOENT and
// `upstage ask` failed at startup. Runs under a private HOME (see m9).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { createSession, loadLatestSession, saveSession, sessionRoot } from "../src/runtime/session.mjs";

async function withHome(fn) {
  const home = await mkdtemp(join(os.tmpdir(), "m39-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function addStaleEntry(id, cwd, updatedAt) {
  const indexPath = join(sessionRoot(), "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.sessions.unshift({ id, updatedAt, workspace: { cwd }, parentSessionId: null });
  await writeFile(indexPath, JSON.stringify(index), "utf8");
}

test("stale index entry for the same workspace falls back to a loadable session and is pruned", () =>
  withHome(async () => {
    const cwd = "/work/project";
    const real = createSession(cwd);
    await saveSession(real);
    await addStaleEntry("00000000-0000-4000-8000-000000000000", cwd, real.updatedAt + 1000);

    const latest = await loadLatestSession(cwd);
    assert.equal(latest.id, real.id);

    const index = JSON.parse(await readFile(join(sessionRoot(), "index.json"), "utf8"));
    assert.deepEqual(index.sessions.map((s) => s.id), [real.id]);
  }));

test("stale entries only: returns null instead of throwing", () =>
  withHome(async () => {
    const real = createSession("/work/a");
    await saveSession(real);
    await rm(join(sessionRoot(), `${real.id}.json`));
    assert.equal(await loadLatestSession("/work/a"), null);
  }));

test("other workspaces are still used, most recent first", () =>
  withHome(async () => {
    const older = createSession("/work/b");
    const newer = createSession("/work/c");
    newer.updatedAt = older.updatedAt + 10;
    await saveSession(older);
    await saveSession(newer);
    assert.equal((await loadLatestSession("/work/none")).id, newer.id);
  }));
