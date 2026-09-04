// Thin adapter over src/upstage/embeddings.mjs so the retriever can treat
// Upstage embeddings polymorphically alongside LocalEmbeddingProvider
// (same embedBatch(texts) shape). Model resolution and the actual HTTP call
// live in embeddings.mjs — this file owns only the retriever-facing
// embedBatch() contract and its `type` ("query" vs "passage") default.
import { embed } from "../../upstage/embeddings.mjs";

export class UpstageEmbeddingProvider {
  constructor() {
    this.apiKey = process.env.UPSTAGE_API_KEY || "";
    this.mode = "upstage";
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  // `type` defaults to "passage" since the retriever's primary use of this
  // provider is embedding document/chunk text for the index; callers
  // embedding the user's search query should pass type: "query" explicitly
  // (see retrieveRelevantChunks in ../index.mjs) — Solar embeddings use a
  // distinct model variant per side of a search.
  async embedBatch(texts, type = "passage") {
    if (!this.isConfigured()) {
      throw new Error("UPSTAGE_API_KEY is not configured for embeddings");
    }

    const vectors = await embed({ texts, type });

    if (vectors.length !== texts.length) {
      throw new Error("Unexpected embedding response shape");
    }
    return vectors;
  }
}
