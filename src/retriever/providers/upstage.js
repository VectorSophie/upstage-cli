const DEFAULT_BASE_URL = process.env.UPSTAGE_API_BASE_URL || "https://api.upstage.ai/v1";
const DEFAULT_EMBED_MODEL = process.env.UPSTAGE_EMBED_MODEL || "embedding-query";

export class UpstageEmbeddingProvider {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.model = options.model || DEFAULT_EMBED_MODEL;
    this.apiKey = options.apiKey || process.env.UPSTAGE_API_KEY || "";
    this.mode = "upstage";
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  async embedBatch(texts) {
    if (!this.isConfigured()) {
      throw new Error("UPSTAGE_API_KEY is not configured for embeddings");
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upstage embeddings failed (${response.status}): ${text}`);
    }

    const payload = await response.json();
    const vectors = Array.isArray(payload.data)
      ? payload.data.map((item) => item.embedding).filter(Array.isArray)
      : [];

    if (vectors.length !== texts.length) {
      throw new Error("Unexpected embedding response shape");
    }
    return vectors;
  }
}
