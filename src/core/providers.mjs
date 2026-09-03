export const PROVIDERS = {
  upstage: {
    id: "upstage",
    name: "Upstage",
    endpoint: "https://api.upstage.ai/v1/chat/completions",
    envKey: "UPSTAGE_API_KEY",
    altEnvKey: null,
    models: ["solar-pro4", "solar-pro3", "solar-pro2", "solar-pro", "solar-mini"],
    format: "openai"
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    altEnvKey: null,
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "o1-mini"],
    format: "openai"
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent",
    envKey: "GEMINI_API_KEY",
    altEnvKey: "GOOGLE_API_KEY",
    models: ["gemini-2.0-flash", "gemini-2.5-pro", "gemini-1.5-flash", "gemini-1.5-pro"],
    format: "gemini"
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    // OpenAI-compatible chat completions API, routing to 300+ models
    // (including free-tier ones) from one key — handy for testing this
    // harness against a non-Upstage model without a paid API key.
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    envKey: "OPENROUTER_API_KEY",
    altEnvKey: null,
    models: [],
    format: "openai"
  }
};

export function getProvider(model) {
  if (!model) return PROVIDERS.upstage;
  const lower = model.toLowerCase();
  if (lower.startsWith("solar")) return PROVIDERS.upstage;
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) return PROVIDERS.openai;
  if (lower.startsWith("gemini")) return PROVIDERS.gemini;
  // OpenRouter's model catalog is entirely "vendor/model" slugs
  // (openai/gpt-oss-120b, meta-llama/llama-3.1-70b, ...) — no native
  // Upstage/OpenAI/Gemini model name looks like that, so this is
  // unambiguous without needing an explicit --provider flag.
  if (lower.includes("/")) return PROVIDERS.openrouter;
  return PROVIDERS.upstage;
}

export function getProviderByName(name) {
  return PROVIDERS[name?.toLowerCase()] ?? null;
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

export function checkProviderKeys() {
  return {
    upstage: Boolean(process.env.UPSTAGE_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY)
  };
}
