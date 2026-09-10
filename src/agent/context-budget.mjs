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

import { loadUpstageMdFiles, buildSystemPrompt } from "../core/system-prompt.mjs";
import { estimateTokens } from "../core/context-manager.mjs";
import { createRegistryWithExtensions } from "../tools/create-registry.mjs";
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

function projectInstructionsTokensFor(cwd) {
  const files = loadUpstageMdFiles(cwd);
  const content = files.map((f) => f.content).join("\n\n");
  return estimateTokens(content);
}

// buildSystemPrompt() is the single source of truth for the actual prompt
// text (src/core/system-prompt.mjs) — rather than re-deriving/duplicating
// its hardcoded instruction strings here (which would drift the moment that
// file changes), the system-prompt-only and skills-only contributions are
// isolated by diffing marginal calls against it with those inputs blanked
// out. Concatenation is not perfectly additive under the CJK-aware ratio at
// string boundaries, but the effect is negligible for a token-BUDGET report.
function systemPromptTokensFor(cwd, projectInstructionsTokens) {
  const base = buildSystemPrompt({ cwd, tools: [], skills: [] }).staticPrefix;
  return Math.max(0, estimateTokens(base) - projectInstructionsTokens);
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

  const projectInstructionsTokens = projectInstructionsTokensFor(cwd);
  const systemPromptTokens = systemPromptTokensFor(cwd, projectInstructionsTokens);
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
    const registry = await createRegistryWithExtensions({ cwd, mcpServers: servers });

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
