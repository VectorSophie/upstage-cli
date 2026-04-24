import fs from 'fs';
import path from 'path';
import os from 'os';

export const SETTINGS_SCHEMA = {
  permissions: {
    defaultMode: 'default',
    allowRules: [],
    denyRules: [],
    allowedTools: [],
    deniedTools: [],
    sandbox: true,
    sandboxAllowPaths: [],
  },
  hooks: {
    PreToolUse: [],
    PostToolUse: [],
    PreToolUseFailure: [],
    PostToolUseFailure: [],
    Notification: [],
    Stop: [],
    SessionStart: [],
  },
  model: 'solar-pro2',
  subagentModel: null,
  fastModel: 'solar-pro2',
  fastMode: false,
  alwaysThinkingEnabled: false,
  autoCompactEnabled: true,
  fileCheckpointingEnabled: true,
  promptSuggestionEnabled: true,
  briefMode: false,
  maxContextTokens: 65536,
  maxOutputTokens: 4096,
  maxTokens: 4096,
  thinkingBudget: 10000,
  compactThreshold: 0.8,
  stream: true,
  mcpServers: {},
  theme: 'auto',
  showThinking: false,
  showToolResults: false,
  showTokenUsage: true,
  vimMode: false,
  terminalBell: false,
  telemetryEnabled: false,
  debugMode: false,
  language: 'ko',
  featureFlags: {},
};

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function applyEnvOverrides(settings) {
  if (process.env.UPSTAGE_MODEL) settings.model = process.env.UPSTAGE_MODEL;
  if (process.env.UPSTAGE_SUBAGENT_MODEL) settings.subagentModel = process.env.UPSTAGE_SUBAGENT_MODEL;
  if (process.env.UPSTAGE_MAX_OUTPUT_TOKENS) {
    const n = parseInt(process.env.UPSTAGE_MAX_OUTPUT_TOKENS, 10);
    if (!isNaN(n)) {
      settings.maxOutputTokens = n;
      settings.maxTokens = n;
    }
  }
  if (process.env.UPSTAGE_MAX_CONTEXT_TOKENS) {
    const n = parseInt(process.env.UPSTAGE_MAX_CONTEXT_TOKENS, 10);
    if (!isNaN(n)) settings.maxContextTokens = n;
  }
  if (process.env.UPSTAGE_BRIEF === '1') settings.briefMode = true;
  if (process.env.UPSTAGE_DEBUG === '1') settings.debugMode = true;
  if (process.env.UPSTAGE_PERMISSION_MODE) settings.permissions.defaultMode = process.env.UPSTAGE_PERMISSION_MODE;
  if (process.env.UPSTAGE_STREAMING === '0') settings.stream = false;
  if (process.env.UPSTAGE_THINKING === '1') settings.alwaysThinkingEnabled = true;
  if (process.env.UPSTAGE_LANGUAGE) settings.language = process.env.UPSTAGE_LANGUAGE;
  if (process.env.UPSTAGE_THEME) settings.theme = process.env.UPSTAGE_THEME;
  if (process.env.UPSTAGE_VIM_MODE === '1') settings.vimMode = true;
  if (process.env.UPSTAGE_SANDBOX === '0') settings.permissions.sandbox = false;
}

export async function loadSettings({ cwd = process.cwd() } = {}) {
  const chain = [
    path.join(os.homedir(), '.upstage', 'settings.json'),
    path.join(cwd, '.upstage', 'settings.json'),
    path.join(cwd, '.upstage', 'settings.local.json'),
  ];

  let merged = deepClone(SETTINGS_SCHEMA);

  for (const file of chain) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      merged = deepMerge(merged, data);
    } catch {
      // File not found or invalid — skip
    }
  }

  applyEnvOverrides(merged);
  return merged;
}
