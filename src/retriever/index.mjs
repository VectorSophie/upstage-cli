import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

import { collectWorkspaceFiles, isLikelyTextFile } from "../tools/lib/fs-utils.mjs";
import { chunkText } from "./chunker.mjs";
import { LocalEmbeddingProvider } from "./providers/local.mjs";
import { UpstageEmbeddingProvider } from "./providers/upstage.mjs";
import { loadVectorStore, saveVectorStore } from "./store/vector-store.mjs";

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return -1;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

function toRepoPath(cwd, filePath) {
  return relative(cwd, filePath).split("\\").join("/");
}

// Bump whenever a change to embedding-vector shape could make an on-disk
// index (~/.upstage-cli or, here, .upstage-cli/index/retrieval-index.json)
// incompatible with what a fresh build would now produce — most importantly,
// a change to the default/effective embedding model's dimension. Without
// this, a stale index built under an old model generation would silently
// mix incompatible vector dimensions: cosineSimilarity() below treats a
// length mismatch as "no similarity" (-1) rather than throwing, so every
// candidate would tie at the same meaningless score instead of erroring.
// Bumped to 2 for the src/upstage/embeddings.mjs fix (Task 7.3): the default
// embedding model generation changed to a different, differently-sized
// vector space. An index missing this marker, or carrying an older one, is
// treated as absent and rebuilt rather than trusted.
const INDEX_SCHEMA_VERSION = 2;

function isUsableDiskIndex(disk, signatures) {
  return Boolean(disk) && disk.indexSchemaVersion === INDEX_SCHEMA_VERSION && sameSignatures(disk.fileSignatures, signatures);
}

async function buildSignatures(cwd, files) {
  const signatures = {};
  for (const filePath of files) {
    const info = await stat(filePath);
    signatures[toRepoPath(cwd, filePath)] = {
      size: info.size,
      mtimeMs: info.mtimeMs
    };
  }
  return signatures;
}

function sameSignatures(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!right[key]) {
      return false;
    }
    if (left[key].size !== right[key].size || left[key].mtimeMs !== right[key].mtimeMs) {
      return false;
    }
  }
  return true;
}

async function readChunks(cwd, files, options = {}) {
  const chunks = [];
  const maxCharsPerFile = Number.isInteger(options.maxCharsPerFile)
    ? options.maxCharsPerFile
    : 8000;

  for (const filePath of files) {
    if (!(await isLikelyTextFile(filePath))) {
      continue;
    }
    const relPath = toRepoPath(cwd, filePath);
    const content = (await readFile(filePath, "utf8")).slice(0, maxCharsPerFile);
    const pieces = chunkText(content, {
      chunkSize: options.chunkSize || 800,
      overlap: options.overlap || 120
    });
    for (let i = 0; i < pieces.length; i += 1) {
      chunks.push({
        id: `${relPath}#${i + 1}`,
        path: relPath,
        text: pieces[i]
      });
    }
  }

  return chunks;
}

async function embedTextsWithFallback(texts, type) {
  const upstage = new UpstageEmbeddingProvider();
  const local = new LocalEmbeddingProvider();

  try {
    const vectors = await upstage.embedBatch(texts, type);
    return { mode: "upstage", vectors };
  } catch {
    const vectors = await local.embedBatch(texts, type);
    return { mode: "local", vectors };
  }
}

export async function ensureRetrievalIndex(cwd, runtimeCache = {}, options = {}) {
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 240;
  const files = await collectWorkspaceFiles(cwd, {
    maxFiles,
    maxDepth: options.maxDepth || 10
  });
  const signatures = await buildSignatures(cwd, files);

  if (
    !options.forceRebuild &&
    runtimeCache.retrievalIndex &&
    runtimeCache.retrievalIndex.indexSchemaVersion === INDEX_SCHEMA_VERSION &&
    sameSignatures(runtimeCache.retrievalIndex.fileSignatures, signatures)
  ) {
    return { ...runtimeCache.retrievalIndex, fromCache: true };
  }

  if (!options.forceRebuild) {
    const disk = await loadVectorStore(cwd);
    if (isUsableDiskIndex(disk, signatures)) {
      runtimeCache.retrievalIndex = { ...disk, fromCache: true };
      return runtimeCache.retrievalIndex;
    }
  }

  const chunks = await readChunks(cwd, files, options);
  const { mode, vectors } = await embedTextsWithFallback(chunks.map((chunk) => chunk.text), "passage");
  const entries = chunks.map((chunk, index) => ({
    ...chunk,
    vector: vectors[index]
  }));

  const index = {
    createdAt: Date.now(),
    indexSchemaVersion: INDEX_SCHEMA_VERSION,
    embeddingMode: mode,
    entries,
    fileSignatures: signatures,
    fromCache: false
  };

  runtimeCache.retrievalIndex = index;
  await saveVectorStore(cwd, index);
  return index;
}

export async function retrieveRelevantChunks({ cwd, query, runtimeCache, topK = 5 }) {
  const index = await ensureRetrievalIndex(cwd, runtimeCache);
  const provider =
    index.embeddingMode === "upstage" ? new UpstageEmbeddingProvider() : new LocalEmbeddingProvider();

  let queryVector;
  try {
    const vectors = await provider.embedBatch([query], "query");
    queryVector = vectors[0];
  } catch {
    const local = new LocalEmbeddingProvider();
    const vectors = await local.embedBatch([query], "query");
    queryVector = vectors[0];
  }

  const ranked = index.entries
    .map((entry) => ({
      ...entry,
      score: cosineSimilarity(queryVector, entry.vector)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({
      path: entry.path,
      score: Number(entry.score.toFixed(4)),
      text: entry.text
    }));

  return {
    mode: index.embeddingMode,
    fromCache: index.fromCache === true,
    chunks: ranked
  };
}
