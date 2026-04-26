export const PROVIDERS = {
  upstage: {
    id: "upstage",
    name: "Upstage",
    endpoint: "https://api.upstage.ai/v1/chat/completions",
    envKey: "UPSTAGE_API_KEY",
    altEnvKey: null,
    models: ["solar-pro2", "solar-pro", "solar-mini"],
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
  }
};

export function getProvider(model) {
  if (!model) return PROVIDERS.upstage;
  const lower = model.toLowerCase();
  if (lower.startsWith("solar")) return PROVIDERS.upstage;
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) return PROVIDERS.openai;
  if (lower.startsWith("gemini")) return PROVIDERS.gemini;
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
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
  };
}
