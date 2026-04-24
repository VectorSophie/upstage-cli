export const ENV_SCHEMA = {
  UPSTAGE_API_KEY: { type: 'string', description: 'Upstage API key' },
  UPSTAGE_BASE_URL: { type: 'string', default: 'https://api.upstage.ai/v1', description: 'Upstage API base URL' },
  UPSTAGE_MODEL: { type: 'string', description: 'Override default model' },
  UPSTAGE_SUBAGENT_MODEL: { type: 'string', description: 'Model for subagents' },
  UPSTAGE_MAX_OUTPUT_TOKENS: { type: 'number', default: 4096, description: 'Max output tokens' },
  UPSTAGE_MAX_CONTEXT_TOKENS: { type: 'number', default: 65536, description: 'Max context window tokens' },
  UPSTAGE_EMBEDDING_MODEL: { type: 'string', default: 'solar-embedding-1-large', description: 'Embedding model name' },
  UPSTAGE_BRIEF: { type: 'boolean', default: false, description: 'Brief output mode' },
  UPSTAGE_DEBUG: { type: 'boolean', default: false, description: 'Debug mode' },
  UPSTAGE_PERMISSION_MODE: { type: 'string', default: 'default', description: 'Permission mode' },
  UPSTAGE_STREAMING: { type: 'boolean', default: true, description: 'Enable streaming' },
  UPSTAGE_THINKING: { type: 'boolean', default: false, description: 'Enable extended thinking' },
  UPSTAGE_LANGUAGE: { type: 'string', default: 'ko', description: 'Default language (ko/en)' },
  UPSTAGE_THEME: { type: 'string', default: 'auto', description: 'UI theme' },
  UPSTAGE_VIM_MODE: { type: 'boolean', default: false, description: 'Vim keybindings' },
  UPSTAGE_SANDBOX: { type: 'boolean', default: true, description: 'Enable sandbox' },
  UPSTAGE_MODEL_CONTEXT_LIMIT: { type: 'number', default: 65536, description: 'Context token limit for budget tracking' },
  UPSTAGE_VERIFY_STAGES: { type: 'string', description: 'Comma-separated verification stages' },
  UPSTAGE_MCP_SERVERS_MODULE: { type: 'string', description: 'Path to MCP servers module' },
  UPSTAGE_DISCOVERY_COMMAND: { type: 'string', description: 'Discovery command' },
  UPSTAGE_DISCOVERY_INVOKE_COMMAND: { type: 'string', description: 'Discovery invoke command' },
  UPSTAGE_AUTO_COMPACT: { type: 'boolean', default: true, description: 'Auto-compact context' },
  UPSTAGE_COMPACT_THRESHOLD: { type: 'number', default: 0.8, description: 'Context compaction threshold' },
  UPSTAGE_HOOK_TIMEOUT: { type: 'number', default: 10000, description: 'Hook execution timeout ms' },
  UPSTAGE_HOOK_FAIL_OPEN: { type: 'boolean', default: true, description: 'Allow on hook failure' },
  UPSTAGE_LOG_LEVEL: { type: 'string', default: 'info', description: 'Log level' },
  UPSTAGE_LOG_FILE: { type: 'string', description: 'Log file path' },
  UPSTAGE_SESSION_TTL: { type: 'number', default: 86400000, description: 'Session TTL ms' },
  UPSTAGE_TOOL_TIMEOUT: { type: 'number', default: 120000, description: 'Tool execution timeout ms' },
  UPSTAGE_API_TIMEOUT: { type: 'number', default: 300000, description: 'API call timeout ms' },
  UPSTAGE_MAX_RETRIES: { type: 'number', default: 5, description: 'Max API retries on 429/529' },
  UPSTAGE_RETRY_BASE_DELAY: { type: 'number', default: 1000, description: 'Base retry delay ms' },
  UPSTAGE_RETRY_MAX_DELAY: { type: 'number', default: 60000, description: 'Max retry delay ms' },
  EDITOR: { type: 'string', description: 'Default text editor' },
  NO_COLOR: { type: 'boolean', default: false, description: 'Disable colored output' },
};

export function readEnv() {
  const env = {};
  for (const [key, schema] of Object.entries(ENV_SCHEMA)) {
    const raw = process.env[key];
    if (raw === undefined) {
      if (schema.default !== undefined) {
        env[key] = schema.default;
      }
      continue;
    }
    switch (schema.type) {
      case 'boolean':
        env[key] = raw === '1' || raw === 'true' || raw === 'yes';
        break;
      case 'number':
        env[key] = parseInt(raw, 10);
        if (isNaN(env[key])) env[key] = schema.default;
        break;
      default:
        env[key] = raw;
    }
  }
  return env;
}

export function getEnv(key, defaultValue) {
  const schema = ENV_SCHEMA[key];
  const raw = process.env[key];
  if (raw === undefined) return defaultValue ?? schema?.default;
  if (schema?.type === 'boolean') return raw === '1' || raw === 'true';
  if (schema?.type === 'number') {
    const n = parseInt(raw, 10);
    return isNaN(n) ? defaultValue : n;
  }
  return raw;
}

export function listEnvVars() {
  const result = [];
  for (const [key, schema] of Object.entries(ENV_SCHEMA)) {
    const value = process.env[key];
    result.push({
      key,
      type: schema.type,
      value: value || undefined,
      default: schema.default,
      description: schema.description,
      isSet: value !== undefined,
    });
  }
  return result;
}
