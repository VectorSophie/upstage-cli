import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "mcp", "upstage-server.mjs");

/** Spawn the MCP server, exchange a set of requests, resolve when all replies
 *  (matched by id) have arrived. Never calls the model. */
function exchange(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, UPSTAGE_API_KEY: "" }
    });
    const replies = new Map();
    const wantIds = requests.filter((r) => r.id !== undefined).map((r) => r.id);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout waiting for MCP replies"));
    }, 10000);

    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && msg.id !== null) replies.set(msg.id, msg);
      if (wantIds.every((id) => replies.has(id))) {
        clearTimeout(timer);
        child.kill();
        resolve(replies);
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
}

test("initialize returns protocolVersion and serverInfo", async () => {
  const replies = await exchange([
    { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }
  ]);
  const r = replies.get(1).result;
  // The server always states its own best-supported version (currently the
  // 2026-07-28 spec), regardless of what the client requested in params.
  assert.equal(r.protocolVersion, "2026-07-28");
  assert.equal(r.serverInfo.name, "upstage-cli");
  assert.ok(r.capabilities.tools);
});

test("tools/list exposes upstage_delegate and upstage_ask", async () => {
  const replies = await exchange([{ id: 2, method: "tools/list", params: {} }]);
  const names = replies.get(2).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["upstage_ask", "upstage_delegate"]);
  for (const t of replies.get(2).result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 0);
  }
});

test("unknown method returns JSON-RPC error -32601", async () => {
  const replies = await exchange([{ id: 3, method: "no/such/method", params: {} }]);
  assert.equal(replies.get(3).error.code, -32601);
});

test("notifications (no id) get no response, server stays alive", async () => {
  // Send a notification first, then a real request — if the notification were
  // answered or crashed the server, the id:4 reply would never arrive.
  const replies = await exchange([
    { method: "notifications/initialized", params: {} },
    { id: 4, method: "ping", params: {} }
  ]);
  assert.ok(replies.has(4));
  assert.deepEqual(replies.get(4).result, {});
});
