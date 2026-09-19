// src/agent/context-budget.mjs
//
// Task 7.15 of the 3.2.0 release plan — shared token-counting/breakdown
// logic behind two surfaces:
//   - `upstage context [--json]` (src/cli/commands/context.mjs) — a
//     repo-level, pre-session budget report. No model call, no live
//     session.
//   - the TUI's `/context` (src/ui/commands.mjs, replacing the old `/memory`
//     stub, which becomes an alias) — a live-session breakdown that extends
//     the same categories with the actual conversation's token cost and the
//     remaining free space.
//
// Token-counting heuristic: reused verbatim from src/core/context-manager.mjs's
// `estimateTokens()` — the CJK-aware chars/4 (chars/2.5 for CJK-heavy text)
// ratio that ContextManager already uses for every compaction decision, and
// that the TUI's existing /compact and /cost handlers already surface via
// `state._contextManager`. This is deliberately NOT the separate, coarser
// chars/4 ratio in src/agent/context-builder.mjs (CONTEXT_CHARS_PER_TOKEN) —
// that ratio exists only to cap the *injected repo-context string length*
// fed into a prompt, it is never used for any compaction/budget decision, and
// reusing it here instead would produce numbers that quietly disagree with
// /compact's and /cost's own before/after figures. See the module comment on
// estimateTokens() in context-manager.mjs.

import { buildSystemPrompt } from "../core/system-prompt.mjs";
import { estimateTokens } from "../core/context-manager.mjs";
import { createRegistryWithExtensions, discoveryConfigFromEnv } from "../tools/create-registry.mjs";
import { loadMcpServerConfigs, connectConfiguredServers } from "../tools/mcp/config.mjs";
import { SkillsLoader } from "../skills/loader.mjs";
import { loadSettings } from "../config/settings.mjs";
import { resolveTokenLimit } from "./loop.mjs";

// Short — a repo-level budget report must never hang on a misbehaving MCP
// server, same rationale/value as doctor.mjs's own MCP_CHECK_TIMEOUT_MS.
const MCP_CONNECT_TIMEOUT_MS = 5000;

const EMPTY_STATIC_CATEGORIES = Object.freeze({
  systemPromptTokens: 0,
  toolsTokens: 0,
  mcpTokens: 0,
  projectInstructionsTokens: 0,
  skillsTokens: 0,
  repoMapTokens: 0
});

function toModelToolShape(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
      parameters: tool.inputSchema || { type: "object", properties: {}, additionalProperties: true }
    }
  };
}

function toolSchemaTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools.map(toModelToolShape)));
}

// buildSystemPrompt() is the single source of truth for the actual prompt
// text (src/core/system-prompt.mjs) — rather than re-deriving/duplicating
// its hardcoded instruction strings here (which would drift the moment that
// file changes), the system-prompt-only, project-instructions-only, and
// skills-only contributions are all isolated by diffing marginal calls
// against it with those inputs blanked out. Concatenation is not perfectly
// additive under the CJK-aware ratio at string boundaries, but the effect is
// negligible for a token-BUDGET report.
//
// systemPromptTokens and projectInstructionsTokens are computed TOGETHER
// from a single matched pair of buildSystemPrompt() calls (the same
// with/without-one-dimension technique skillsTokensFor uses below —
// `includeProjectInstructions: true` vs `false`, everything else identical),
// rather than one call site building the full prompt and a second,
// independent loadUpstageMdFiles() call re-deriving the project-instructions
// content to subtract. Two independent call sites deriving the same content
// would have to be kept parameter-synced by hand (e.g. if an `addDirs`
// option is ever threaded through) — one drifting out of sync with the
// other would silently break the additive relationship this whole budget
// report depends on. Deriving both numbers from the exact same pair of
// calls makes that drift structurally impossible instead of merely avoided
// by care. (The fixed-size language reminder buildSystemPrompt appends
// whenever project instructions are present appears identically in both
// calls — see its own comment — so it cancels out of the diff and lands in
// systemPromptTokens, same bucket as before this rewrite.)
function systemPromptAndProjectInstructionsTokensFor(cwd) {
  const withInstructions = buildSystemPrompt({ cwd, tools: [], skills: [] }).staticPrefix;
  const withoutInstructions = buildSystemPrompt({
    cwd,
    tools: [],
    skills: [],
    includeProjectInstructions: false
  }).staticPrefix;

  const withTokens = estimateTokens(withInstructions);
  const withoutTokens = estimateTokens(withoutInstructions);

  return {
    systemPromptTokens: withoutTokens,
    projectInstructionsTokens: Math.max(0, withTokens - withoutTokens)
  };
}

function skillsTokensFor(cwd, skills) {
  if (!Array.isArray(skills) || skills.length === 0) return 0;
  const withSkills = buildSystemPrompt({ cwd, tools: [], skills }).staticPrefix;
  const without = buildSystemPrompt({ cwd, tools: [], skills: [] }).staticPrefix;
  return Math.max(0, estimateTokens(withSkills) - estimateTokens(without));
}

async function repoMapTokensFor(registry, cwd) {
  if (!registry || typeof registry.execute !== "function") return 0;
  const result = await registry.execute("repo_map", { maxFiles: 30 }, { cwd });
  if (!result?.ok) return 0;
  return estimateTokens(result.data?.map || "");
}

/**
 * The six categories both surfaces share: system prompt / builtin (+
 * discovered) tools / MCP tools / project instructions (UPSTAGE.md/
 * AGENTS.md) / skills catalog / repo map — all tokenized with the exact
 * same estimateTokens() ContextManager already uses. `registry` must expose
 * `.listActive({source})` and `.execute(name, args, ctx)` (a real
 * ToolRegistry, live or freshly built); `skills` is the already-loaded skill
 * list (from a SkillsLoader or state._skillsLoader).
 */
async function computeStaticCategories({ cwd, registry, skills }) {
  if (!registry) return { ...EMPTY_STATIC_CATEGORIES };

  const { systemPromptTokens, projectInstructionsTokens } = systemPromptAndProjectInstructionsTokensFor(cwd);
  const skillsTokens = skillsTokensFor(cwd, skills);

  const builtinTools = [
    ...registry.listActive({ source: "builtin" }),
    ...registry.listActive({ source: "discovered" })
  ];
  const mcpTools = registry.listActive({ source: "mcp" });

  const toolsTokens = toolSchemaTokens(builtinTools);
  const mcpTokens = toolSchemaTokens(mcpTools);
  const repoMapTokens = await repoMapTokensFor(registry, cwd);

  return { systemPromptTokens, toolsTokens, mcpTokens, projectInstructionsTokens, skillsTokens, repoMapTokens };
}

// Best-effort: no MCP servers configured, or a server that fails to connect
// within the timeout, both resolve to an empty server list (mcpTokens: 0)
// rather than throwing — same posture as doctor.mjs's gatherMcpStatus().
async function connectMcpBestEffort(cwd, settings) {
  try {
    const configs = await loadMcpServerConfigs(cwd, settings, { onLog: () => {} });
    if (configs.length === 0) {
      return { servers: [], closeAll: async () => {} };
    }
    return await connectConfiguredServers(configs, { cwd, timeoutMs: MCP_CONNECT_TIMEOUT_MS, onLog: () => {} });
  } catch {
    return { servers: [], closeAll: async () => {} };
  }
}

/**
 * Repo-level context budget — no session, no model call. Reports where a
 * FRESH session's context window would go before the first prompt even
 * runs: project instructions (UPSTAGE.md/AGENTS.md), the repo map, a
 * system-prompt baseline, and builtin/MCP tool schema cost, against the
 * resolved model's context limit (src/model/model-capabilities.mjs, via the
 * same resolveTokenLimit() the live agent loop uses — honors
 * UPSTAGE_MODEL_CONTEXT_LIMIT).
 *
 * Returns `{ systemPromptTokens, toolsTokens, mcpTokens,
 * projectInstructionsTokens, skillsTokens, repoMapTokens, contextLimit }`.
 */
export async function computeContextBudget({ cwd = process.cwd(), model } = {}) {
  const settings = await loadSettings({ cwd }).catch(() => ({}));
  const resolvedModel = model || settings.model;
  const contextLimit = resolveTokenLimit(resolvedModel);

  const { servers, closeAll } = await connectMcpBestEffort(cwd, settings);
  try {
    // Same discovery resolution src/cli/index.mjs's real session wiring uses
    // (both call the shared discoveryConfigFromEnv() in create-registry.mjs)
    // — without this, `registry.listActive({source: "discovered"})` below is
    // structurally empty for any project with UPSTAGE_DISCOVERY_COMMAND
    // configured, silently undercounting the tools category.
    const discovery = discoveryConfigFromEnv({ cwd });
    let registry;
    try {
      registry = await createRegistryWithExtensions({ cwd, discovery, mcpServers: servers });
    } catch {
      // Same degrade-rather-than-crash posture as tools.mjs's
      // buildFullToolRegistry(): a misbehaving discovery command (bad JSON,
      // non-zero exit, ...) should undercount discovered tools, not blow up
      // a repo-level budget report.
      registry = await createRegistryWithExtensions({ cwd, mcpServers: servers });
    }

    const skillsLoader = new SkillsLoader();
    await skillsLoader.load(cwd);
    const skills = skillsLoader.list();

    const categories = await computeStaticCategories({ cwd, registry, skills });
    return { ...categories, contextLimit };
  } finally {
    await closeAll().catch(() => {});
  }
}

/**
 * Live-session breakdown — extends the repo-level categories with the
 * actual conversation's token cost and remaining free space, computed via
 * the SAME ContextManager instance (`state._contextManager`) already
 * powering the TUI's /compact and /cost, so these numbers can never
 * disagree with those commands' own before/after figures. `state._registry`
 * (if present) supplies the already-connected live tool set (builtin +
 * MCP + discovered) instead of reconnecting anything.
 *
 * Returns the same shape as computeContextBudget() plus `conversationTokens`
 * and `freeSpaceTokens`; the eight fields sum to `contextLimit` (clamped at
 * 0 if usage already exceeds it).
 */
export async function computeLiveContextBreakdown(messages, state) {
  const cwd = state?._session?.workspace?.cwd || process.cwd();
  const registry = state?._registry || null;
  const skills = state?._skillsLoader?.list?.() || [];

  const categories = await computeStaticCategories({ cwd, registry, skills });

  const contextManager = state?._contextManager || null;
  const contextLimit = contextManager?.maxTokens ?? resolveTokenLimit(state?.model);
  const conversationTokens = contextManager ? contextManager.getTokenCount(messages || []) : 0;

  const usedTokens =
    categories.systemPromptTokens +
    categories.toolsTokens +
    categories.mcpTokens +
    categories.projectInstructionsTokens +
    categories.skillsTokens +
    categories.repoMapTokens +
    conversationTokens;
  const freeSpaceTokens = Math.max(0, contextLimit - usedTokens);

  return { ...categories, conversationTokens, freeSpaceTokens, contextLimit };
}
