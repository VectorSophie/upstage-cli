import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodingAgent } from "../interface.mjs";
import { buildAgentRegistry, extractUsage } from "./upstage.mjs";
import { getLocalModelConfig, LOCAL_MODEL_IDS } from "../local-models.mjs";

const CLI_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../src");

async function importFromCli(relPath) {
  return import(pathToFileURL(resolve(CLI_ROOT, relPath)).href);
}

/**
 * LocalModelAgent — one shared adapter for all four locally served, OpenAI-
 * compatible Korean models. It reuses EXACTLY the same machinery as UpstageAgent:
 *   - buildAgentRegistry() → the real tool registry, write-root trust, path
 *     confinement, docker isolation, and task tool-policy (nothing re-implemented);
 *   - the real CLI agent loop (runAgentLoop/collectAgentLoop) and session;
 * only the model client differs: a LocalOpenAIAdapter pointed at the model's
 * validated local endpoint, configured from local-models.mjs. There is ONE loop
 * and ONE registry path for every model — model differences are pure config.
 */
export class LocalModelAgent extends CodingAgent {
  constructor({ model, baseUrl, timeoutMs } = {}) {
    super();
    this._key = (model || "").toLowerCase() || null;
    this._config = this._key ? getLocalModelConfig(this._key) : null;
    this._baseUrlOverride = baseUrl || null;
    this._timeoutMs = typeof timeoutMs === "number" ? timeoutMs : undefined;
  }

  get id() {
    return this._key ? `local-${this._key}` : "local";
  }

  get displayName() {
    if (!this._config) {
      return `Local model (set --model to one of: ${LOCAL_MODEL_IDS.join(", ")})`;
    }
    return this._config.displayName;
  }

  // Every command this agent runs goes through the task executor (same as
  // UpstageAgent), so it is safe on docker-isolated tasks.
  get supportsSandbox() {
    return true;
  }

  // Available when a known model key is configured. Reachability of the live
  // server is intentionally NOT probed here (no network in isAvailable); a dead
  // endpoint surfaces as a classified adapter error during run(), which the
  // runner records as status=error (not a task failure).
  isAvailable() {
    return !!this._config;
  }

  _resolvedBaseUrl() {
    return this._baseUrlOverride || this._config.baseUrl;
  }

  async run(task, context) {
    if (!this._config) {
      return {
        ok: false,
        error: `Unknown local model '${this._key}'. Known: ${LOCAL_MODEL_IDS.join(", ")}`,
        turns: null,
        toolCalls: null,
        usage: null,
        events: []
      };
    }

    const { runAgentLoop, collectAgentLoop } = await importFromCli("agent/loop.mjs");
    const { LocalOpenAIAdapter } = await importFromCli("model/local-openai-adapter.mjs");
    const { createSession } = await importFromCli("runtime/session.mjs");
    const { DEFAULT_LOOP_BUDGET } = await importFromCli("config/defaults.mjs");

    const { workdir, auditLog, executor } = context;
    const cfg = this._config;
    const prov = cfg.provenance;

    const maxTurns = task.agent?.maxTurns || 6;
    const timeoutMs = (task.sandbox?.timeout || 120) * 1000;

    const { registry, tools } = await buildAgentRegistry(task, { workdir, executor });
    const modelTools = registry.toModelTools();
    const toolSchemaHash = createHash("sha256").update(JSON.stringify(modelTools)).digest("hex");

    // Output budget: a task may lower it, but never raise it above the model's
    // validated ceiling (Solar's 4K keeps prompt+output inside its 8K context).
    const taskMaxTokens = task.agent?.maxTokens;
    const maxTokens =
      typeof taskMaxTokens === "number" && taskMaxTokens > 0
        ? Math.min(taskMaxTokens, cfg.maxOutputTokens)
        : cfg.maxOutputTokens;

    const adapter = new LocalOpenAIAdapter({
      model: cfg.servedModelName,
      baseUrl: this._resolvedBaseUrl(),
      apiKey: process.env.LOCAL_MODEL_API_KEY || "",
      temperature: cfg.sampling.temperature,
      topP: cfg.sampling.topP,
      topK: cfg.sampling.topK,
      presencePenalty: cfg.sampling.presencePenalty,
      maxTokens,
      chatTemplateKwargs: cfg.chatTemplateKwargs || undefined,
      timeoutMs: this._timeoutMs
    });

    const session = createSession(workdir);

    const gen = runAgentLoop({
      input: task.prompt,
      registry,
      cwd: workdir,
      adapter,
      stream: false,
      session,
      budget: { ...DEFAULT_LOOP_BUDGET, maxSteps: maxTurns, maxWallTimeMs: timeoutMs },
      settings: {},
      addDirs: []
    });

    const { result, events } = await collectAgentLoop(gen);

    if (auditLog) auditLog.recordEvents(events);

    // A model/transport failure (adapter threw → loop stops with MODEL_ERROR) is
    // INFRASTRUCTURE, not a task outcome. Re-throw so the runner records it as
    // status=error (agent_adapter_error), keeping it distinct from a genuine task
    // failure where the model ran but produced a wrong/incomplete patch. Other
    // non-ok stop reasons (budget_exhausted, tool_error, needs_user_input,
    // policy_blocked) mean the agent actually ran, so they flow through to checks.
    if (!result?.ok && result?.stopReason === "model_error") {
      throw new Error(result?.response || "local model adapter error");
    }

    const turns = Array.isArray(result?.trace) ? result.trace.filter((t) => t.step !== undefined).length : null;
    const reasoning = adapter.reasoningSummary();
    const gpuContended = process.env.GPU_CONTENDED === "true" ? true : process.env.GPU_CONTENDED === "false" ? false : null;

    return {
      ok: !!result?.ok,
      error: result?.ok ? undefined : result?.response,
      turns,
      toolCalls: events.filter((e) => e.type === "tool_start").length,
      usage: extractUsage(events),
      events,
      stopReason: result?.stopReason,
      // Provenance sink (runner stores this verbatim into provenance.model).
      model: {
        provider: prov.provider,
        id: cfg.servedModelName,
        hfRepo: prov.hfRepo,
        revision: prov.revision,
        quantization: prov.quantization,
        official: prov.official,
        quantizationSource: prov.quantizationSource ?? null,
        servingRuntime: prov.servingRuntime,
        servingImage: prov.servingImage,
        tensorParallel: prov.tensorParallel,
        reasoningParser: prov.reasoningParser,
        toolCallParser: prov.toolCallParser,
        logitsProcessor: prov.logitsProcessor,
        maxNumSeqs: prov.maxNumSeqs ?? null,
        baseUrl: this._resolvedBaseUrl(),
        sampling: {
          temperature: adapter.temperature ?? null,
          topP: adapter.topP ?? null,
          topK: adapter.topK ?? null,
          presencePenalty: adapter.presencePenalty ?? null,
          seed: adapter.seed ?? null
        },
        chatTemplateKwargs: cfg.chatTemplateKwargs ?? null,
        maxOutputTokens: maxTokens,
        contextLimit: cfg.contextLimit,
        reasoning: {
          // Kept strictly separate; never conflated with completion tokens or content.
          reasoningChars: reasoning.reasoningChars, // characters, not tokens (null if none)
          tokenizerReasoningTokens: null, // not computed here (would need the tokenizer)
          providerReasoningTokens: reasoning.providerReasoningTokens // null unless reliably reported
        },
        gpuContended
      },
      tools: { ...tools, schemaHash: toolSchemaHash }
    };
  }
}
