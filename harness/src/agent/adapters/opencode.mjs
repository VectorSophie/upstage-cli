import { spawnSync } from "node:child_process";
import { CodingAgent } from "../interface.mjs";

const TIMEOUT_MS = 5 * 60 * 1000;

export class OpenCodeAgent extends CodingAgent {
  constructor({ model } = {}) {
    super();
    this._model = model || null;
  }

  get id() {
    return "opencode";
  }

  get displayName() {
    return `OpenCode${this._model ? ` (${this._model})` : ""}`;
  }

  isAvailable() {
    const r = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  }

  async run(task, context) {
    const { workdir, auditLog } = context;

    const args = ["run", "--no-tty", task.prompt];
    if (this._model) args.push("--model", this._model);

    const start = Date.now();
    const result = spawnSync("opencode", args, {
      cwd: workdir,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env }
    });

    const durationMs = Date.now() - start;

    if (result.error) {
      return this._errorResult(result.error.message);
    }

    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      return this._errorResult(stderr || `opencode exited with code ${result.status}`);
    }

    const events = [{ type: "opencode_output", text: (result.stdout || "").slice(0, 2000) }];
    if (auditLog) auditLog.recordEvents(events);

    return {
      ok: true,
      turns: 1,
      toolCalls: 0,
      usage: null,
      events,
      stopReason: "end_turn"
    };
  }

  _errorResult(message) {
    return { ok: false, error: message, turns: 0, toolCalls: 0, usage: null, events: [], stopReason: "error" };
  }
}
