import { createInterface } from "node:readline";

/**
 * BridgeServer — a bidirectional NDJSON bridge so an editor/IDE extension can
 * drive the agent over a pipe (the foundation under the existing
 * `--bridge-json` one-shot stream).
 *
 * Transport: one JSON object per line, both directions.
 *
 * Client → server:
 *   { "type": "initialize", "clientInfo": {...} }
 *   { "type": "prompt", "id": "p1", "text": "...", "cwd": "/abs" }
 *   { "type": "cancel", "id": "p1" }
 *   { "type": "ping" }
 *
 * Server → client:
 *   { "type": "ready" }                              (on start)
 *   { "type": "initialized", "serverInfo": {...} }
 *   { "type": "event", "id": "p1", "event": {...} }  (per agent event)
 *   { "type": "result", "id": "p1", "ok": true, "response": "..." }
 *   { "type": "pong" } | { "type": "error", "message": "..." }
 *
 * `runAgent` is injected: an async generator `({ prompt, cwd, sessionId, signal })`
 * that yields agent events and returns a result object — exactly the shape of
 * `runAgentLoop`. This keeps the protocol layer testable without the model.
 */

const SERVER_INFO = { name: "upstage-cli-bridge", version: "2.6.2" };

export class BridgeServer {
  constructor({ input, output, runAgent, sessionId = "bridge" } = {}) {
    if (typeof runAgent !== "function") throw new Error("runAgent is required");
    this.input = input;
    this.output = output;
    this.runAgent = runAgent;
    this.sessionId = sessionId;
    this._active = new Map(); // id → AbortController
  }

  _send(obj) {
    this.output.write(JSON.stringify(obj) + "\n");
  }

  start() {
    this._send({ type: "ready", serverInfo: SERVER_INFO });
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this._send({ type: "error", message: "invalid JSON" });
        return;
      }
      this._handle(msg).catch((err) => this._send({ type: "error", message: err?.message || String(err) }));
    });
    return new Promise((resolve) => rl.on("close", resolve));
  }

  async _handle(msg) {
    switch (msg.type) {
      case "initialize":
        this._send({ type: "initialized", serverInfo: SERVER_INFO, capabilities: { prompt: true, cancel: true } });
        return;
      case "ping":
        this._send({ type: "pong" });
        return;
      case "cancel": {
        const ctrl = this._active.get(msg.id);
        if (ctrl) ctrl.abort();
        return;
      }
      case "prompt":
        await this._runPrompt(msg);
        return;
      default:
        this._send({ type: "error", message: `unknown message type: ${msg.type}` });
    }
  }

  async _runPrompt(msg) {
    const id = msg.id ?? null;
    if (typeof msg.text !== "string" || msg.text.length === 0) {
      this._send({ type: "result", id, ok: false, response: "prompt 'text' is required" });
      return;
    }
    const controller = new AbortController();
    if (id != null) this._active.set(id, controller);

    const gen = this.runAgent({
      prompt: msg.text,
      cwd: msg.cwd || process.cwd(),
      sessionId: this.sessionId,
      signal: controller.signal
    });

    let result = { ok: true };
    try {
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value || result;
          break;
        }
        if (controller.signal.aborted) {
          if (typeof gen.return === "function") await gen.return();
          this._send({ type: "result", id, ok: false, response: "cancelled" });
          this._active.delete(id);
          return;
        }
        this._send({ type: "event", id, event: value });
      }
    } catch (err) {
      this._send({ type: "result", id, ok: false, response: err?.message || String(err) });
      this._active.delete(id);
      return;
    }

    this._active.delete(id);
    this._send({ type: "result", id, ok: result.ok !== false, response: result.response ?? null, stopReason: result.stopReason ?? null });
  }
}
