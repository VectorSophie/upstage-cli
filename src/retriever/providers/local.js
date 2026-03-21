const VECTOR_SIZE = 64;

function tokenToIndex(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % VECTOR_SIZE;
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function embedOne(text) {
  const vector = new Array(VECTOR_SIZE).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(Boolean);

  for (const token of tokens) {
    vector[tokenToIndex(token)] += 1;
  }
  return normalize(vector);
}

export class LocalEmbeddingProvider {
  constructor() {
    this.mode = "local";
  }

  async embedBatch(texts) {
    return texts.map((text) => embedOne(text));
  }
}
