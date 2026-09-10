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
  model: 'solar-pro4',
  subagentModel: null,
  fastModel: 'solar-pro4',
  reasoningEffort: 'auto', // 'auto' | 'low' | 'high' — reasoning-effort switch, support varies by model (see src/model/model-capabilities.mjs)
  fastMode: false,
  alwaysThinkingEnabled: false,
  autoCompactEnabled: true,
  fileCheckpointingEnabled: true,
  promptSuggestionEnabled: true,
  briefMode: false,
  maxContextTokens: null,
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
  // Agent-loop guardrails (src/config/defaults.mjs DEFAULT_LOOP_BUDGET).
  // null = use the built-in default; set any field to override.
  loopBudget: {
    maxSteps: null,
    maxToolCalls: null,
    maxWallTimeMs: null,
    maxCostUsd: null,
  },
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
  if (process.env.UPSTAGE_MAX_WALL_TIME_MS) {
    const n = parseInt(process.env.UPSTAGE_MAX_WALL_TIME_MS, 10);
    if (!isNaN(n)) settings.loopBudget.maxWallTimeMs = n;
  }
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

/** File path for the global settings layer (`~/.upstage/settings.json`). */
export function globalSettingsPath() {
  return path.join(os.homedir(), '.upstage', 'settings.json');
}

/** File path for the project settings layer (`<cwd>/.upstage/settings.json`) —
 *  the ONE file `config get`/`config set`/`config edit` are allowed to write. */
export function projectSettingsPath(cwd = process.cwd()) {
  return path.join(cwd, '.upstage', 'settings.json');
}

/** File path for the project-local (gitignored-by-convention) settings layer. */
export function projectLocalSettingsPath(cwd = process.cwd()) {
  return path.join(cwd, '.upstage', 'settings.local.json');
}

// Source labels used by loadSettingsWithProvenance()'s returned `provenance`
// map — kept as named constants so `config.mjs` and its tests reference the
// same literal strings rather than duplicating them.
export const PROVENANCE_SOURCE = {
  DEFAULT: 'default',
  GLOBAL: 'global settings',
  PROJECT: 'project settings',
  LOCAL: 'project local settings',
  ENV: 'env',
};

/** For every top-level key of `next`/`prev`, marks `provenance[key] = label`
 *  whenever that key's value actually changed between the two snapshots
 *  (compared by JSON-serialized content, not reference — deepMerge always
 *  builds fresh container objects, so reference equality would over-report
 *  changes on keys nothing touched). Shared by every layer transition in
 *  loadSettingsWithProvenance() below. */
function attributeChangedKeys(next, prev, label, provenance) {
  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) {
      provenance[key] = label;
    }
  }
}

/**
 * Task 12.7 (`config list --effective`) — a provenance-tracking sibling of
 * `loadSettings()`. Rather than rewriting the cascade to carry attribution
 * through inline, this re-runs the EXACT same `deepMerge`/`applyEnvOverrides`
 * primitives `loadSettings()` uses, once per additional layer (schema-only →
 * +global → +project → +local → +env), diffing each pass against the
 * previous one to attribute the *last* layer that changed each top-level
 * key. This is deliberately the multi-pass-diff approach from the release
 * plan's §7.T detail — cheap (a handful of small JSON files) and reuses the
 * cascade logic verbatim instead of maintaining a second, provenance-aware
 * copy of it. This relies on `deepMerge` being idempotent under repeated
 * application with the same source — verified separately (see this task's
 * report / m33-config-cli.test.mjs's dedicated idempotency test) before this
 * function was written.
 *
 * Returns `{ settings, provenance }` where `provenance` maps every top-level
 * SETTINGS_SCHEMA key to one of PROVENANCE_SOURCE's labels — the layer that
 * last set it, or 'default' if no layer ever touched it.
 */
export async function loadSettingsWithProvenance({ cwd = process.cwd() } = {}) {
  const layers = [
    { label: PROVENANCE_SOURCE.GLOBAL, file: globalSettingsPath() },
    { label: PROVENANCE_SOURCE.PROJECT, file: projectSettingsPath(cwd) },
    { label: PROVENANCE_SOURCE.LOCAL, file: projectLocalSettingsPath(cwd) },
  ];

  let merged = deepClone(SETTINGS_SCHEMA);
  const provenance = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) provenance[key] = PROVENANCE_SOURCE.DEFAULT;

  for (const layer of layers) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(layer.file, 'utf-8'));
    } catch {
      // File not found or invalid — skip, exactly like loadSettings().
      continue;
    }
    const next = deepMerge(merged, data);
    attributeChangedKeys(next, merged, layer.label, provenance);
    merged = next;
  }

  // applyEnvOverrides mutates its argument in place (see above) rather than
  // returning a new object, so the "before" snapshot for the diff has to be
  // taken explicitly — deepClone() rather than reusing `merged` by reference.
  const beforeEnv = deepClone(merged);
  applyEnvOverrides(merged);
  attributeChangedKeys(merged, beforeEnv, PROVENANCE_SOURCE.ENV, provenance);

  return { settings: merged, provenance };
}
