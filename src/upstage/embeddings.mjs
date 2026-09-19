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
const VALID_TYPES = ["query", "passage"];

// UPSTAGE_EMBEDDING_MODEL is the one canonical override env var (see
// src/config/env.mjs's ENV_SCHEMA) for the embedding model *base* name — it
// gets suffixed with "-query" or "-passage" here, the same way the default
// does. This is the only place that reads it, so every caller of embed()
// picks up the same value automatically.
//
// `type` is validated strictly (exactly "query" or "passage") rather than
// falling through to a default for anything else: today's callers are
// trusted internal code using literals, but this module is meant to be
// called directly by future entry points (a standalone `upstage embed` CLI
// command, MCP exposure) where `type` may come from end-user input. A typo
// like "Query" silently resolving to the query model would produce a
// wrong-but-valid-looking embedding instead of an error.
function resolveModel(type) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`type must be one of ${VALID_TYPES.map((t) => `"${t}"`).join(" or ")}, got: ${JSON.stringify(type)}`);
  }
  const base = process.env.UPSTAGE_EMBEDDING_MODEL || DEFAULT_BASE_MODEL;
  return `${base}-${type}`;
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
 * @throws {Error} if `texts` is empty, `type` isn't exactly "query" or
 *   "passage", or the API response doesn't contain one embedding array per
 *   input text.
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

  const vectors = Array.isArray(data?.data) ? data.data.map((d) => d.embedding) : [];
  if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v))) {
    throw new Error("Upstage embeddings API returned an unexpected response shape");
  }
  return vectors;
}
