/**
 * HttpMcpClient — a real MCP client over the **Streamable HTTP** transport
 * (MCP spec 2025-03-26, retained 2025-11-25; supersedes the deprecated HTTP+SSE
 * transport). Single endpoint, JSON-RPC over HTTP POST; the server may answer
 * with either a JSON body or an SSE stream.
 *
 * Same surface as StdioMcpClient (`connect` / `listTools` / `callTool` / `close`)
 * so `McpClientManager.registerServer(name, client)` treats them identically.
 *
 * Implements: initialize handshake, `Mcp-Session-Id` propagation,
 * `MCP-Protocol-Version` header, `Accept: application/json, text/event-stream`,
 * and session teardown via HTTP DELETE on close.
 */

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "upstage-cli", version: "2.6.1" };

/** Parse an SSE payload, return the JSON-RPC message whose id matches, or the
 *  last parseable `data:` object if no id filter is given. */
function extractFromSse(text, wantId) {
  let fallback = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    let msg;
    try {
      msg = JSON.parse(dataLines.join("\n"));
    } catch {
      continue;
    }
    if (wantId !== undefined && msg.id === wantId) return msg;
    fallback = msg;
  }
  return wantId === undefined ? fallback : fallback;
}

export class HttpMcpClient {
  constructor({ url, headers = {}, name = "mcp", timeoutMs = 30000 } = {}) {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("HttpMcpClient: url is required");
    }
    this.url = url;
    this.headers = headers;
    this.name = name;
    this.timeoutMs = timeoutMs;

    this._nextId = 1;
    this._sessionId = null;
    this._protocolVersion = PROTOCOL_VERSION;
    this._serverInfo = null;
    this._closed = false;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async connect() {
    const initResult = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO
    });
    this._serverInfo = initResult?.serverInfo || null;
    if (initResult?.protocolVersion) this._protocolVersion = initResult.protocolVersion;
    await this._notify("notifications/initialized", {});
    return initResult;
  }

  async close() {
    this._closed = true;
    if (!this._sessionId) return;
    try {
      await fetch(this.url, { method: "DELETE", headers: this._buildHeaders() });
    } catch { /* best-effort teardown */ }
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

  // ── HTTP plumbing ──────────────────────────────────────────────────────────

  _buildHeaders(extra = {}) {
    const h = {
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this._protocolVersion,
      ...this.headers,
      ...extra
    };
    if (this._sessionId) h["Mcp-Session-Id"] = this._sessionId;
    return h;
  }

  async _post(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this._buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(message),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`MCP request '${message.method}' to '${this.name}' timed out after ${this.timeoutMs}ms`, { cause: err });
      }
      throw new Error(`MCP request to '${this.name}' failed: ${err.message}`, { cause: err });
    }
    clearTimeout(timer);

    // Capture/refresh the session id (servers set it on initialize).
    const sid = res.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;

    return res;
  }

  async _request(method, params) {
    if (this._closed) throw new Error(`MCP server '${this.name}' is closed`);
    const id = this._nextId++;
    const res = await this._post({ jsonrpc: "2.0", id, method, params });

    if (!res.ok) {
      throw new Error(`MCP server '${this.name}' returned HTTP ${res.status} for '${method}'`);
    }

    const contentType = res.headers.get("content-type") || "";
    let msg;
    if (contentType.includes("text/event-stream")) {
      msg = extractFromSse(await res.text(), id);
    } else {
      msg = await res.json();
    }
    if (!msg) throw new Error(`MCP server '${this.name}' returned no response for '${method}'`);
    if (msg.error) {
      throw new Error(`MCP error from '${this.name}': ${msg.error.message || JSON.stringify(msg.error)}`);
    }
    return msg.result;
  }

  async _notify(method, params) {
    // Notifications carry no id; servers reply 202 Accepted with no body.
    await this._post({ jsonrpc: "2.0", method, params }).catch(() => {});
  }
}
