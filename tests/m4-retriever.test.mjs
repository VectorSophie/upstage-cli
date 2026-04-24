import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { ensureRetrievalIndex, retrieveRelevantChunks } from "../src/retriever/index.mjs";

async function createWorkspace() {
  const cwd = await mkdtemp(join(os.tmpdir(), "upstage-cli-m4-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(
    join(cwd, "src", "payments.js"),
    "export function chargeCard(cardToken, amount) { return { ok: true, amount }; }\n",
    "utf8"
  );
  await writeFile(
    join(cwd, "src", "users.js"),
    "export function getUserProfile(userId) { return { id: userId }; }\n",
    "utf8"
  );
  return cwd;
}

test("retriever builds index with local fallback when upstage embedding is unavailable", async () => {
  const cwd = await createWorkspace();
  try {
    const runtimeCache = {};
    const index = await ensureRetrievalIndex(cwd, runtimeCache, {
      maxFiles: 50,
      maxDepth: 5
    });

    assert.ok(index.entries.length > 0);
    assert.equal(index.embeddingMode, "local");
    assert.equal(index.fromCache, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retriever returns ranked semantic chunks", async () => {
  const cwd = await createWorkspace();
  try {
    const runtimeCache = {};
    await ensureRetrievalIndex(cwd, runtimeCache, {
      maxFiles: 50,
      maxDepth: 5
    });

    const result = await retrieveRelevantChunks({
      cwd,
      query: "card payment amount charge",
      runtimeCache,
      topK: 3
    });

    assert.equal(result.mode, "local");
    assert.ok(Array.isArray(result.chunks));
    assert.ok(result.chunks.length > 0);
    assert.ok(result.chunks[0].path.startsWith("src/"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
