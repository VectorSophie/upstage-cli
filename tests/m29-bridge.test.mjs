import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { BridgeServer } from "../src/bridge/bridge-server.mjs";

/** Collect NDJSON objects emitted by the server until `predicate` is satisfied. */
function collectUntil(stream, predicate) {
  return new Promise((resolve) => {
    const msgs = [];
    let buf = "";
    stream.on("data", (chunk) => {
      buf += String(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        msgs.push(obj);
        if (predicate(obj, msgs)) resolve(msgs);
      }
    });
  });
}

function startServer(runAgent) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new BridgeServer({ input, output, runAgent });
  server.start();
  const send = (obj) => input.write(JSON.stringify(obj) + "\n");
  return { input, output, send };
}

// A stub agent: yields two events, returns a result. No model involved.
async function* stubAgent({ prompt }) {
  yield { type: "thinking", thought: "planning" };
  yield { type: "stream_token", text: `echo:${prompt}` };
  return { ok: true, response: `done:${prompt}`, stopReason: "done" };
}

test("emits ready on start and answers ping/initialize", async () => {
  const { output, send } = startServer(stubAgent);
  const done = collectUntil(output, (m) => m.type === "pong");
  send({ type: "initialize", clientInfo: { name: "test" } });
  send({ type: "ping" });
  const msgs = await done;
  assert.equal(msgs[0].type, "ready");
  assert.ok(msgs.some((m) => m.type === "initialized" && m.serverInfo.name));
  assert.ok(msgs.some((m) => m.type === "pong"));
});

test("prompt streams tagged events then a result", async () => {
  const { output, send } = startServer(stubAgent);
  const done = collectUntil(output, (m) => m.type === "result");
  send({ type: "prompt", id: "p1", text: "hi", cwd: process.cwd() });
  const msgs = await done;

  const events = msgs.filter((m) => m.type === "event" && m.id === "p1");
  assert.ok(events.length >= 2);
  assert.equal(events[0].event.type, "thinking");
  const result = msgs.find((m) => m.type === "result");
  assert.equal(result.id, "p1");
  assert.equal(result.ok, true);
  assert.equal(result.response, "done:hi");
});

test("unknown message type and empty prompt are reported, server stays up", async () => {
  const { output, send } = startServer(stubAgent);
  const done = collectUntil(output, (m) => m.type === "result" && m.id === "p2");
  send({ type: "frobnicate" });
  send({ type: "prompt", id: "p2", text: "" });
  const msgs = await done;
  assert.ok(msgs.some((m) => m.type === "error" && /unknown message type/.test(m.message)));
  const result = msgs.find((m) => m.type === "result" && m.id === "p2");
  assert.equal(result.ok, false);
});
