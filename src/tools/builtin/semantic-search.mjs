import { request } from "node:https";

// Solar embeddings — explicitly positioned by Upstage for Korean-language
// vector understanding, unlike our existing search-code/grep/repo-map tools
// which are keyword/tree-sitter based and miss semantic matches across
// Korean identifiers, comments, or paraphrased queries. Scoped narrowly:
// this ranks candidate snippets the agent already gathered (via grep/glob/
// read_file), rather than building a standalone repo-wide index/pipeline —
// real, working semantic ranking without a large indexing subsystem.
//
// Endpoint/model confirmed from langchain-upstage's UpstageEmbeddings (the
// real SDK, not guessed): OpenAI-compatible POST /v1/embeddings, model
// name gets a "-query" or "-passage" suffix depending on which side of the
// search it's embedding.
const ENDPOINT = "https://api.upstage.ai/v1/embeddings";
const BASE_MODEL = process.env.UPSTAGE_EMBEDDING_MODEL || "solar-embedding-1-large";
const MAX_CANDIDATES = 100;

function postJson(url, apiKey, body) {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 30000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) return reject(new Error(`Embeddings API ${res.statusCode}: ${text.slice(0, 500)}`));
          try { resolvePromise(JSON.parse(text)); } catch (err) { reject(err); }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Embeddings request timed out")); });
    req.write(payload);
    req.end();
  });
}

async function embed(apiKey, model, input) {
  const data = await postJson(ENDPOINT, apiKey, { model, input });
  return (data.data || []).map((d) => d.embedding);
}

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
    const apiKey = process.env.UPSTAGE_API_KEY;
    if (!apiKey) throw new Error("UPSTAGE_API_KEY is not configured");
    if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required");
    if (!Array.isArray(args.candidates) || args.candidates.length === 0) throw new Error("candidates must be a non-empty array");

    const candidates = args.candidates.slice(0, MAX_CANDIDATES);
    const topK = Math.max(1, Math.min(typeof args.topK === "number" ? args.topK : 5, candidates.length));

    const [queryEmbedding] = await embed(apiKey, `${BASE_MODEL}-query`, [args.query.trim()]);
    const candidateEmbeddings = await embed(apiKey, `${BASE_MODEL}-passage`, candidates);

    const ranked = candidates
      .map((text, i) => ({ index: i, text, score: cosineSimilarity(queryEmbedding, candidateEmbeddings[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return { query: args.query, results: ranked };
  }
};
