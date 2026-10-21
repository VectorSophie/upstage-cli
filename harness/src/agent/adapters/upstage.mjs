import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodingAgent } from "../interface.mjs";
import { createToolPolicy, enforceToolPolicy } from "../tool-policy.mjs";
import { confineRegistryToSandbox, confineFileTools, removeEscapingSymlinks } from "../sandboxed-tools.mjs";

const CLI_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../src");

async function importFromCli(relPath) {
  const absPath = resolve(CLI_ROOT, relPath);
  return import(pathToFileURL(absPath).href);
}

/**
 * The tool registry an agent gets for one attempt — the same one the live
 * Upstage loop uses, so tests can exercise it without a model:
 *   - writes are trusted only inside `workdir` (an explicit PolicyEngine; the
 *     CLI default would trust the harness process's cwd instead)
 *   - file-tool paths are realpath-confined to `workdir` (docker and native)
 *   - docker: host-only tools removed, run_shell/run_tests sent to `executor`
 *   - task agent.tools allow/deny applied last
 */
export async function buildAgentRegistry(task, { workdir, executor } = {}) {
  const { createRegistryWithExtensions } = await importFromCli("tools/create-registry.mjs");
  const { PolicyEngine } = await importFromCli("core/policy/engine.mjs");

  const policyEngine = new PolicyEngine({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: true,
    trustedWritePaths: [workdir]
  });
  const registry = await createRegistryWithExtensions({
    policy: { allowHighRiskTools: true, policyEngine },
    cwd: workdir,
    permissionMode: task.agent?.permissions || "acceptEdits"
  });

  const policy = createToolPolicy(task.agent?.tools || {});
  let removedForIsolation = [];
  if (executor?.type === "docker") {
    removeEscapingSymlinks(workdir);
    removedForIsolation = confineRegistryToSandbox(registry, executor, workdir, { explicitAllow: policy.allow }).removed;
  } else {
    confineFileTools(registry, workdir);
  }
  const { advertised, removed } = enforceToolPolicy(registry, policy);
  return { registry, tools: { advertised, removedByPolicy: removed, removedForIsolation } };
}

export class UpstageAgent extends CodingAgent {
  constructor({ model } = {}) {
    super();
    this._model = model || null;
  }

  get id() {
    // Without --model the CLI's own default model is used; the resolved id is
    // recorded per run in result.model (it is not necessarily solar-pro2).
    return this._model ? `upstage-${this._model}` : "upstage";
  }

  get displayName() {
    return `Upstage Solar (${this._model || "CLI default model"})`;
  }

  // Agent-controlled execution is routed into the task's DockerSandbox
  get supportsSandbox() {
    return true;
  }

  isAvailable() {
    return !!(process.env.UPSTAGE_API_KEY);
  }

  async run(task, context) {
    const { runAgentLoop, collectAgentLoop } = await importFromCli("agent/loop.mjs");
    const { UpstageAdapter } = await importFromCli("model/upstage-adapter.mjs");
    const { createSession } = await importFromCli("runtime/session.mjs");
    const { DEFAULT_LOOP_BUDGET } = await importFromCli("config/defaults.mjs");

    const { workdir, auditLog, executor } = context;

    const maxTurns = task.agent?.maxTurns || 6;
    const timeoutMs = (task.sandbox?.timeout || 120) * 1000;

    const { registry, tools } = await buildAgentRegistry(task, { workdir, executor });

    const modelTools = registry.toModelTools();
    const toolSchemaHash = createHash("sha256").update(JSON.stringify(modelTools)).digest("hex");

    const adapter = new UpstageAdapter({ model: this._model || undefined });
    const session = createSession(workdir);

    const gen = runAgentLoop({
      input: task.prompt,
      registry,
      cwd: workdir,
      adapter,
      stream: false,
      session,
      // maxTurns / timeout are enforced through the loop budget (settings.maxTurns is not read by the loop)
      budget: { ...DEFAULT_LOOP_BUDGET, maxSteps: maxTurns, maxWallTimeMs: timeoutMs },
      settings: {},
      addDirs: []
    });

    const { result, events } = await collectAgentLoop(gen);

    if (auditLog) {
      auditLog.recordEvents(events);
    }

    const turns = Array.isArray(result?.trace) ? result.trace.filter((t) => t.step !== undefined).length : null;

    return {
      ok: !!result?.ok,
      error: result?.ok ? undefined : result?.response,
      turns,
      toolCalls: events.filter((e) => e.type === "tool_start").length,
      usage: extractUsage(events),
      events,
      stopReason: result?.stopReason,
      model: {
        provider: "upstage",
        id: adapter.model,
        revision: null,
        sampling: { temperature: adapter.temperature ?? null, seed: null },
        maxOutputTokens: null,
        contextLimit: null
      },
      tools: { ...tools, schemaHash: toolSchemaHash }
    };
  }
}

/**
 * Sums per-call usage over every token_usage event (each event is one model
 * call). Returns null — unknown, not zero — when the provider reported none.
 */
export function extractUsage(events) {
  const usageEvents = events.filter((e) => e.type === "token_usage" && e.usage);
  if (usageEvents.length === 0) return null;
  const total = { promptTokens: 0, completionTokens: 0, totalTokens: 0, modelCalls: usageEvents.length };
  for (const { usage: u } of usageEvents) {
    const p = u.promptTokens ?? u.prompt_tokens ?? 0;
    const c = u.completionTokens ?? u.completion_tokens ?? 0;
    total.promptTokens += p;
    total.completionTokens += c;
    total.totalTokens += u.totalTokens ?? u.total_tokens ?? p + c;
  }
  return total;
}
