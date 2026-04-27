import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodingAgent } from "../interface.mjs";

const CLI_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../src");

async function importFromCli(relPath) {
  const absPath = resolve(CLI_ROOT, relPath);
  return import(pathToFileURL(absPath).href);
}

export class UpstageAgent extends CodingAgent {
  constructor({ model } = {}) {
    super();
    this._model = model || null;
  }

  get id() {
    return this._model ? `upstage-${this._model}` : "upstage-solar-pro2";
  }

  get displayName() {
    return `Upstage Solar (${this._model || "solar-pro2"})`;
  }

  isAvailable() {
    return !!(process.env.UPSTAGE_API_KEY);
  }

  async run(task, context) {
    const { runAgentLoop, collectAgentLoop } = await importFromCli("agent/loop.mjs");
    const { createRegistryWithExtensions } = await importFromCli("tools/create-registry.mjs");
    const { UpstageAdapter } = await importFromCli("model/upstage-adapter.mjs");
    const { createSession } = await importFromCli("runtime/session.mjs");

    const { workdir, auditLog } = context;

    const permissionMode = task.agent?.permissions || "acceptEdits";
    const maxTurns = task.agent?.maxTurns || 6;

    const registry = await createRegistryWithExtensions({
      policy: { allowHighRiskTools: true },
      cwd: workdir,
      permissionMode
    });

    const adapter = new UpstageAdapter({ model: this._model || undefined });
    const session = createSession(workdir);

    const toolsAllow = task.agent?.tools?.allow || [];
    const toolsDeny = new Set(task.agent?.tools?.deny || []);

    const gen = runAgentLoop({
      input: task.prompt,
      registry,
      cwd: workdir,
      adapter,
      stream: false,
      session,
      settings: { maxTurns },
      addDirs: []
    });

    const { result, events } = await collectAgentLoop(gen);

    if (auditLog) {
      auditLog.recordEvents(events);
    }

    const usage = extractUsage(events);
    const toolCallCount = events.filter((e) => e.type === "tool_start").length;
    const turnCount = events.filter((e) => e.type === "stream_token" || e.type === "thinking").length;

    return {
      ok: result.ok,
      error: result.ok ? undefined : result.response,
      turns: Math.max(turnCount, 1),
      toolCalls: toolCallCount,
      usage,
      events,
      stopReason: result.stopReason
    };
  }
}

function extractUsage(events) {
  const usageEvent = events.find((e) => e.type === "token_usage");
  if (!usageEvent?.usage) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const u = usageEvent.usage;
  return {
    promptTokens: u.prompt_tokens || u.promptTokens || 0,
    completionTokens: u.completion_tokens || u.completionTokens || 0,
    totalTokens: u.total_tokens || u.totalTokens || 0
  };
}
