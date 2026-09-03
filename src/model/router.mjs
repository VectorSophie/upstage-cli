const WRITE_PATTERN = /\b(fix|add|implement|refactor|update|change|edit|create|write|migrate|delete|rename|move|install|setup|configure|build|generate|debug|modify|patch|apply|replace|insert|append|rewrite|remove)\b/i;

export function estimateTaskComplexity(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content) return "complex";
  const text = typeof lastUser.content === "string" ? lastUser.content : "";
  if (text.length > 300) return "complex";
  if (WRITE_PATTERN.test(text)) return "complex";
  return "simple";
}

export class ModelRouter {
  constructor({ proAdapter, fastAdapter }) {
    this._pro = proAdapter;
    this._fast = fastAdapter || proAdapter;
  }

  isConfigured() {
    return this._pro.isConfigured();
  }

  get model() {
    return this._pro.model;
  }

  setReasoningEffort(value) {
    this._pro.setReasoningEffort?.(value);
    this._fast.setReasoningEffort?.(value);
  }

  async complete(options) {
    const complexity = estimateTaskComplexity(options.messages || []);
    const adapter = complexity === "simple" ? this._fast : this._pro;
    return adapter.complete(options);
  }
}
