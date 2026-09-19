import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "mcp", "upstage-server.mjs");

/** Spawn the MCP server, exchange a set of requests, resolve when all replies
 *  (matched by id) have arrived. Never calls the model (UPSTAGE_API_KEY is
 *  blank by default, so any tool that hits the network fails fast with
 *  "UPSTAGE_API_KEY is not configured" rather than making a real HTTP call —
 *  `env` lets a test override that, e.g. to point at a local mock server). */
function exchange(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, UPSTAGE_API_KEY: "", ...env }
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
  // Genuine no-regression check: the two original agent-delegation tools
  // must still be present, not just replaced by the new Document AI ones.
  assert.deepEqual(names, [
    "upstage_ask",
    "upstage_classify",
    "upstage_delegate",
    "upstage_embed",
    "upstage_extract",
    "upstage_groundedness",
    "upstage_parse"
  ]);
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

test("tools/call for an unknown tool name returns a JSON-RPC error, not a crash", async () => {
  const replies = await exchange([{ id: 5, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }]);
  assert.equal(replies.get(5).error.code, -32602);
});

// --- upstage_embed: tools/call, mocked -------------------------------------
//
// upstage-server.mjs's new Document AI tools (upstage_parse/upstage_extract/
// upstage_classify/upstage_embed/upstage_groundedness) call src/upstage/*.mjs
// service functions directly rather than through the agent loop, and those
// functions hit the network via upstageRequest()/UpstageAdapter. Because this
// test spawns the server as a real child process (see exchange() above),
// there is no way to monkey-patch its global.fetch from here the way the
// m33-upstage-*.test.mjs suite does within a single process (that pattern is
// documented there as this repo's only available ESM-module-mocking
// workaround). The equivalent boundary for a spawned process is the network
// itself, not the module graph — so these tests stand up a tiny local HTTP
// server and point the child at it via UPSTAGE_API_BASE_URL, which both
// client.mjs and upstage-adapter.mjs already read (see client.mjs's header).
// upstage_embed is used as the "at least one new tool" case since it's a
// plain JSON POST (unlike the multipart document-upload tools), keeping the
// mock server trivial.
function withMockUpstageServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          handler(req, Buffer.concat(chunks).toString("utf8"), res);
        } catch (err) {
          reject(err);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      Promise.resolve()
        .then(() => run(`http://127.0.0.1:${port}`))
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });
}

test("tools/call upstage_embed (success): returns the embeddings, shaped as an MCP text result", async () => {
  await withMockUpstageServer(
    (req, body, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/embeddings");
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed.input, ["hello", "world"]);
      assert.match(parsed.model, /-passage$/);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }));
    },
    async (baseUrl) => {
      const replies = await exchange(
        [
          {
            id: 10,
            method: "tools/call",
            params: { name: "upstage_embed", arguments: { texts: ["hello", "world"], type: "passage" } }
          }
        ],
        { UPSTAGE_API_KEY: "test-key", UPSTAGE_API_BASE_URL: baseUrl }
      );
      const result = replies.get(10).result;
      assert.equal(result.isError, false);
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /Embeddings result/);
      assert.match(result.content[0].text, /- count: 2/);
      assert.match(result.content[0].text, /0\.1.*0\.2.*0\.3.*0\.4/s);
    }
  );
});

test("tools/call upstage_embed (thrown error): surfaced as an isError result, not a crash", async () => {
  // No UPSTAGE_API_KEY override — exchange()'s default env sets it to "",
  // so embed() -> upstageRequest() throws UpstageApiError before any network
  // call, exercising the same catch path a live API failure would take.
  const replies = await exchange([
    { id: 11, method: "tools/call", params: { name: "upstage_embed", arguments: { texts: ["hello"] } } }
  ]);
  const result = replies.get(11).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /UPSTAGE_API_KEY is not configured/);
});

// --- upstage_parse / upstage_extract / upstage_classify: client-side ------
// validation errors, no network involved at all ------------------------------
//
// parseDocument()/extractStructured()/classifyDocument() all validate their
// arguments (path presence/existence, categories bounds) BEFORE touching the
// network — same as embed()'s empty-texts/bad-type checks. These are the
// cheapest possible "handler wires arguments through and errors propagate as
// an isError result" tests: no mock server, no real file, no API key needed.

test("tools/call upstage_parse (thrown error): nonexistent path surfaced as isError, not a crash", async () => {
  const replies = await exchange([
    {
      id: 12,
      method: "tools/call",
      params: { name: "upstage_parse", arguments: { path: "definitely-does-not-exist.pdf" } }
    }
  ]);
  const result = replies.get(12).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /File not found/);
});

test("tools/call upstage_extract (thrown error): missing path surfaced as isError, not a crash", async () => {
  const replies = await exchange([
    {
      id: 13,
      method: "tools/call",
      params: { name: "upstage_extract", arguments: { schema: { type: "object", properties: {} } } }
    }
  ]);
  const result = replies.get(13).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /requires a `path`/);
});

test("tools/call upstage_classify (thrown error): too few categories surfaced as isError, not a crash", async () => {
  const replies = await exchange([
    {
      id: 14,
      method: "tools/call",
      params: { name: "upstage_classify", arguments: { path: "irrelevant.pdf", categories: ["only-one"] } }
    }
  ]);
  const result = replies.get(14).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /at least 2 categories/);
});

// --- upstage_groundedness: tools/call, mocked -------------------------------
//
// checkGroundedness() calls UpstageAdapter directly (a chat-completions call,
// not upstageRequest()) — see groundedness.mjs's header. It still reads the
// same UPSTAGE_API_BASE_URL and POSTs plain JSON, this time to
// `{baseUrl}/chat/completions`, so withMockUpstageServer works unchanged;
// only the routed path and response shape (`choices[0].message.content`,
// matching upstage-adapter.mjs's readJsonResponse()) differ from the embed case.
test("tools/call upstage_groundedness (success): returns the grounding verdict, shaped as an MCP text result", async () => {
  await withMockUpstageServer(
    (req, body, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/chat/completions");
      const parsed = JSON.parse(body);
      assert.equal(parsed.messages[0].role, "user");
      assert.equal(parsed.messages[0].content, "The sky is blue.");
      assert.equal(parsed.messages[1].role, "assistant");
      assert.equal(parsed.messages[1].content, "The sky's color is blue.");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "grounded" } }] }));
    },
    async (baseUrl) => {
      const replies = await exchange(
        [
          {
            id: 15,
            method: "tools/call",
            params: {
              name: "upstage_groundedness",
              arguments: { context: "The sky is blue.", answer: "The sky's color is blue." }
            }
          }
        ],
        { UPSTAGE_API_KEY: "test-key", UPSTAGE_API_BASE_URL: baseUrl }
      );
      const result = replies.get(15).result;
      assert.equal(result.isError, false);
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /Groundedness Check result/);
      assert.match(result.content[0].text, /- grounded: grounded/);
      assert.match(result.content[0].text, /### Raw model response\ngrounded/);
    }
  );
});
