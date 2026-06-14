import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { HttpMcpClient } from "../src/tools/mcp/http-client.mjs";
import { loadMcpServerConfigs, connectConfiguredServers } from "../src/tools/mcp/config.mjs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_ID = "sess-abc-123";

/** A minimal Streamable-HTTP MCP server:
 *  - initialize → JSON body + Mcp-Session-Id header
 *  - tools/list → JSON body (asserts the session header is echoed back)
 *  - tools/call → SSE (text/event-stream) response (exercises the SSE parser)
 *  - notifications/* → 202 Accepted, no body
 *  - DELETE → 200 */
function startMockHttpServer() {
  const seenSessionOn = {};
  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const sid = req.headers["mcp-session-id"];
      if (msg.method) seenSessionOn[msg.method] = sid || null;

      // Notification (no id) → accepted, no content.
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": SESSION_ID });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-http", version: "1.0" } } }));
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] } }));
        return;
      }
      if (msg.method === "tools/call") {
        // Reply as an SSE stream — the client must extract the matching id.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }] } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no method" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/mcp`, server, seenSessionOn });
    });
  });
}

test("http client: initialize captures session, tools/call parses SSE, session propagates", async () => {
  const { url, server, seenSessionOn } = await startMockHttpServer();
  try {
    const client = new HttpMcpClient({ url, name: "mock-http", timeoutMs: 5000 });
    const init = await client.connect();
    assert.equal(init.serverInfo.name, "mock-http");

    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["ping"]);

    const res = await client.callTool("ping", {});
    assert.equal(res.content[0].text, "pong");

    // The session id from initialize must be sent on later requests.
    assert.equal(seenSessionOn["tools/list"], SESSION_ID);
    assert.equal(seenSessionOn["tools/call"], SESSION_ID);

    await client.close();
  } finally {
    server.close();
  }
});

test("http error status surfaces as a thrown error", async () => {
  const server = createServer((req, res) => { res.writeHead(500).end("boom"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const client = new HttpMcpClient({ url: `http://127.0.0.1:${port}/mcp`, name: "bad", timeoutMs: 3000 });
    await assert.rejects(() => client.connect(), /HTTP 500/);
  } finally {
    server.close();
  }
});

test(".mcp.json url entry produces an http transport config and registers tools", async () => {
  const { url, server } = await startMockHttpServer();
  const dir = await mkdtemp(join(tmpdir(), "mcp-http-"));
  try {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url } } }));
    const configs = await loadMcpServerConfigs(dir, {});
    assert.equal(configs.length, 1);
    assert.equal(configs[0].transport, "http");

    const { servers, closeAll } = await connectConfiguredServers(configs, { cwd: dir });
    assert.equal(servers.length, 1);
    const tools = await servers[0].client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["ping"]);
    await closeAll();
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
