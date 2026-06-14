import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * StdioMcpClient — a real MCP client over the stdio transport.
 *
 * Speaks JSON-RPC 2.0 as newline-delimited JSON on a child process's
 * stdin/stdout (the MCP stdio transport: one message per line, no embedded
 * newlines). Implements the handshake (`initialize` + `notifications/initialized`)
 * and exposes `listTools()` / `callTool()` so it plugs directly into
 * `McpClientManager.registerServer(name, client)`.
 *
 * This is what lets upstage-cli *consume* the real MCP ecosystem — e.g.
 *   new StdioMcpClient({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] })
 */

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "upstage-cli", version: "2.6.1" };

export class StdioMcpClient {
  constructor({ command, args = [], env = {}, cwd, name = "mcp", timeoutMs = 30000 } = {}) {
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("StdioMcpClient: command is required");
    }
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.name = name;
    this.timeoutMs = timeoutMs;

    this.child = null;
    this._nextId = 1;
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._closed = false;
    this._serverInfo = null;
    this._capabilities = null;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async connect() {
    // On Windows, bare shim commands (npx, npm, uvx, yarn → `.cmd` files) need a
    // shell to launch, but a path/`.exe` command must NOT use the shell (shell
    // mode concatenates args without quoting and breaks on spaces, e.g.
    // "C:\Program Files\nodejs\node.exe"). So shell only for bare, extension-less
    // command names.
    const isBareCommand = !/[\\/]/.test(this.command) && !/\.(exe|com)$/i.test(this.command);
    const useShell = process.platform === "win32" && isBareCommand;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell
    });
    this.child = child;

    child.on("error", (err) => this._failAll(new Error(`MCP server '${this.name}' failed to start: ${err.message}`)));
    child.on("exit", (code) => {
      this._closed = true;
      this._failAll(new Error(`MCP server '${this.name}' exited (code ${code})`));
    });

    // Server diagnostics go to stderr — surface them prefixed, never parse.
    if (child.stderr) {
      const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      errRl.on("line", (line) => {
        if (line.trim()) process.stderr.write(`[mcp:${this.name}] ${line}\n`);
      });
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this._onLine(line));

    const initResult = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO
    });
    this._serverInfo = initResult?.serverInfo || null;
    this._capabilities = initResult?.capabilities || null;

    // Per spec the client confirms readiness with a notification (no id, no reply).
    this._notify("notifications/initialized", {});
    return initResult;
  }

  async close() {
    this._closed = true;
    this._failAll(new Error(`MCP server '${this.name}' closed`));
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
  }

  // ── MCP surface ────────────────────────────────────────────────────────────

  async listTools() {
    const result = await this._request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(toolName, args = {}) {
    return this._request("tools/call", { name: toolName, arguments: args || {} });
  }

  get serverInfo() {
    return this._serverInfo;
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  _request(method, params) {
    if (this._closed) {
      return Promise.reject(new Error(`MCP server '${this.name}' is closed`));
    }
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request '${method}' to '${this.name}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  _notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  _write(message) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Some servers noisily log to stdout — ignore anything that isn't JSON-RPC.
      return;
    }
    // We only initiate requests, so we only care about responses (those with id).
    if (msg.id === undefined || msg.id === null) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`MCP error from '${this.name}': ${msg.error.message || JSON.stringify(msg.error)}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  _failAll(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }
}
