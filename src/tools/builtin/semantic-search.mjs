import { embed } from "../../upstage/embeddings.mjs";

// Solar embeddings — explicitly positioned by Upstage for Korean-language
// vector understanding, unlike our existing search-code/grep/repo-map tools
// which are keyword/tree-sitter based and miss semantic matches across
// Korean identifiers, comments, or paraphrased queries. Scoped narrowly:
// this ranks candidate snippets the agent already gathered (via grep/glob/
// read_file), rather than building a standalone repo-wide index/pipeline —
// real, working semantic ranking without a large indexing subsystem.
//
// Model resolution and the actual HTTP call live in src/upstage/embeddings.mjs
// (shared with src/retriever/providers/upstage.mjs) — this file only owns
// the tool's ranking contract.
const MAX_CANDIDATES = 100;

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export const semanticSearchTool = {
  name: "semantic_search",
  description:
    "Rank a set of text candidates (function bodies, file excerpts, comments — gather them first with grep/glob/" +
    "read_file) by semantic relevance to a query, using Upstage's Korean-optimized Solar embeddings. Use this when " +
    "keyword/grep search misses matches because of Korean identifiers, paraphrasing, or synonym mismatch that " +
    "keyword search can't catch.",
  risk: "low",
  actionClass: "network",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you're looking for" },
      candidates: {
        type: "array",
        items: { type: "string" },
        description: `Text snippets to rank against the query (max ${MAX_CANDIDATES})`
      },
      topK: { type: "number", description: "How many top results to return (default 5)" }
    },
    required: ["query", "candidates"],
    additionalProperties: false
  },
  async execute(args) {
    if (!process.env.UPSTAGE_API_KEY) throw new Error("UPSTAGE_API_KEY is not configured");
    if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required");
    if (!Array.isArray(args.candidates) || args.candidates.length === 0) throw new Error("candidates must be a non-empty array");

    const candidates = args.candidates.slice(0, MAX_CANDIDATES);
    const topK = Math.max(1, Math.min(typeof args.topK === "number" ? args.topK : 5, candidates.length));

    const [queryEmbedding] = await embed({ texts: [args.query.trim()], type: "query" });
    const candidateEmbeddings = await embed({ texts: candidates, type: "passage" });

    const ranked = candidates
      .map((text, i) => ({ index: i, text, score: cosineSimilarity(queryEmbedding, candidateEmbeddings[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return { query: args.query, results: ranked };
  }
};
