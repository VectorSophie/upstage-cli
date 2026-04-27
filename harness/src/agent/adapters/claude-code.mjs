import { spawnSync } from "node:child_process";
import { CodingAgent } from "../interface.mjs";

const TIMEOUT_MS = 5 * 60 * 1000;

export class ClaudeCodeAgent extends CodingAgent {
  constructor({ model } = {}) {
    super();
    this._model = model || null;
  }

  get id() {
    return "claude-code";
  }

  get displayName() {
    return `Claude Code${this._model ? ` (${this._model})` : ""}`;
  }

  isAvailable() {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  }

  async run(task, context) {
    const { workdir, auditLog } = context;
    const prompt = task.prompt;

    const args = ["--print", prompt, "--output-format", "stream-json", "--no-verbose"];
    if (this._model) args.push("--model", this._model);

    const start = Date.now();
    const result = spawnSync("claude", args, {
      cwd: workdir,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env }
    });

    const durationMs = Date.now() - start;

    if (result.error) {
      return this._errorResult(result.error.message, durationMs);
    }

    if (result.status !== 0) {
      const msg = (result.stderr || "").trim() || `claude exited with code ${result.status}`;
      return this._errorResult(msg, durationMs);
    }

    return this._parseOutput(result.stdout || "", durationMs, auditLog);
  }

  _parseOutput(stdout, durationMs, auditLog) {
    let toolCalls = 0;
    let turns = 0;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const events = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }

      events.push(obj);

      if (obj.type === "tool_use") toolCalls++;
      if (obj.type === "assistant") turns++;
      if (obj.usage) {
        usage = {
          promptTokens: obj.usage.input_tokens || 0,
          completionTokens: obj.usage.output_tokens || 0,
          totalTokens: (obj.usage.input_tokens || 0) + (obj.usage.output_tokens || 0)
        };
      }
    }

    if (auditLog) auditLog.recordEvents(events);

    return {
      ok: true,
      turns: Math.max(turns, 1),
      toolCalls,
      usage,
      events,
      stopReason: "end_turn"
    };
  }

  _errorResult(message, durationMs) {
    return { ok: false, error: message, turns: 0, toolCalls: 0, usage: null, events: [], stopReason: "error" };
  }
}
