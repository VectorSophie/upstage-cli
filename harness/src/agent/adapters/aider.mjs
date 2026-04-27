import { spawnSync } from "node:child_process";
import { CodingAgent } from "../interface.mjs";

const TIMEOUT_MS = 5 * 60 * 1000;

export class AiderAgent extends CodingAgent {
  constructor({ model } = {}) {
    super();
    this._model = model || null;
  }

  get id() {
    return "aider";
  }

  get displayName() {
    return `Aider${this._model ? ` (${this._model})` : ""}`;
  }

  isAvailable() {
    const r = spawnSync("aider", ["--version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  }

  async run(task, context) {
    const { workdir, auditLog } = context;

    const args = [
      "--message", task.prompt,
      "--yes",        // non-interactive: auto-confirm edits
      "--no-git",     // harness manages git separately
      "--no-stream"   // batch output
    ];
    if (this._model) args.push("--model", this._model);

    const start = Date.now();
    const result = spawnSync("aider", args, {
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
      const stdout = (result.stdout || "").trim();
      return this._errorResult(stderr || stdout || `aider exited with code ${result.status}`);
    }

    const toolCalls = countEdits(result.stdout || "");
    const events = [{ type: "aider_output", text: (result.stdout || "").slice(0, 2000) }];
    if (auditLog) auditLog.recordEvents(events);

    return {
      ok: true,
      turns: 1,
      toolCalls,
      usage: null,
      events,
      stopReason: "end_turn"
    };
  }

  _errorResult(message) {
    return { ok: false, error: message, turns: 0, toolCalls: 0, usage: null, events: [], stopReason: "error" };
  }
}

function countEdits(stdout) {
  // Aider prints "Wrote X" or file diff lines — count modified file references
  const matches = stdout.match(/^(Applied edit|Wrote|Updated):/gm);
  return matches ? matches.length : 1;
}
