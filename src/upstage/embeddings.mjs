// Upstage Embeddings — POST /embeddings, OpenAI-compatible request shape
// ({model, input} -> {data: [{embedding: number[]}, ...]}).
//
// Solar embeddings are asymmetric: a search has a "query" side and a
// "passage"/document side, each served by its own model variant sharing a
// common base name (base + "-query" / base + "-passage"). This is confirmed
// by both pre-existing callers in this repo, which agreed on the
// {model, input} request shape and the data[].embedding response shape, but
// disagreed on the actual base model name and its override env var — each
// had drifted to its own stale default. This module is now the single
// source of truth for embedding model resolution, fixing that
// two-different-stale-model-name bug: see git history / the 3.2.0 release
// plan (docs/superpowers/plans/) for the specifics of what each caller used
// to default to. DEFAULT_BASE_MODEL below is the current, correct
// generation (1,024-dim vectors) confirmed against Upstage's live API.
//
// This module owns embedding API calls + model-name resolution only. No
// ranking/similarity/caching logic lives here — that belongs to callers.
import { upstageRequest } from "./client.mjs";

const ENDPOINT = "/embeddings";
const DEFAULT_BASE_MODEL = "solar-embedding-2";

// UPSTAGE_EMBEDDING_MODEL is the one canonical override env var (see
// src/config/env.mjs's ENV_SCHEMA) for the embedding model *base* name — it
// gets suffixed with "-query" or "-passage" here, the same way the default
// does. This is the only place that reads it, so every caller of embed()
// picks up the same value automatically.
function resolveModel(type) {
  const base = process.env.UPSTAGE_EMBEDDING_MODEL || DEFAULT_BASE_MODEL;
  return type === "passage" ? `${base}-passage` : `${base}-query`;
}

/**
 * Embed a batch of texts via Upstage's Solar embeddings.
 *
 * @param {object} options
 * @param {string[]} options.texts - texts to embed (non-empty).
 * @param {"query"|"passage"} [options.type="query"] - which side of a
 *   search this batch represents. Solar embeddings use a distinct model
 *   variant per side; pick "query" for the user's search text and
 *   "passage" for the candidate/document text being searched over.
 * @returns {Promise<number[][]>} one embedding vector per input text, in
 *   the same order as `texts`.
 */
export async function embed({ texts, type = "query" } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error("embed() requires a non-empty `texts` array");
  }

  const model = resolveModel(type);
  const data = await upstageRequest({
    path: ENDPOINT,
    body: { model, input: texts }
  });

  return (data?.data || []).map((d) => d.embedding);
}
