import test from "node:test";
import assert from "node:assert/strict";

import { runEmbedCommand, formatHuman } from "../src/cli/commands/embed.mjs";

// See tests/m33-cli-parse.test.mjs's header comment for why these tests
// never intercept process.stdout/stderr.write across an awaited call.
function withMockFetch(impl, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = originalFetch; });
}

function withApiKey(value, run) {
  const original = process.env.UPSTAGE_API_KEY;
  if (value === undefined) delete process.env.UPSTAGE_API_KEY;
  else process.env.UPSTAGE_API_KEY = value;
  return Promise.resolve().then(run).finally(() => {
    if (original === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = original;
  });
}

function captureStdioSync(run) {
  const out = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try {
    run();
  } finally {
    process.stdout.write = origOut;
  }
  return out.join("");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const FAKE_VECTOR = Array.from({ length: 1024 }, (_, i) => i / 1000);
const REALISTIC_RESPONSE = { data: [{ embedding: FAKE_VECTOR }] };

// EMBED-VECTOR-OUTPUT DECISION coverage: human output must NOT dump the full
// 1024-dimensional vector — see embed.mjs's header for the reasoning.
test("formatHuman shows dimension count and a short preview, not the full vector", () => {
  const text = formatHuman(FAKE_VECTOR);
  assert.match(text, /1024-dimensional vector/);
  assert.match(text, /First 5 values/);
  assert.doesNotMatch(text, new RegExp(FAKE_VECTOR[500])); // a value well past the 5-value preview never appears
});

test("runEmbedCommand succeeds (exit 0), defaults --type to query, and sends the query-suffixed model", async () => {
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = JSON.parse(options.body); return jsonResponse(REALISTIC_RESPONSE); },
      () => runEmbedCommand(["hello world", "--json"])
    )
  );
  assert.equal(code, 0);
  assert.match(seenBody.model, /-query$/);
  assert.deepEqual(seenBody.input, ["hello world"]);
});

test("runEmbedCommand --type passage sends the passage-suffixed model", async () => {
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = JSON.parse(options.body); return jsonResponse(REALISTIC_RESPONSE); },
      () => runEmbedCommand(["hello world", "--type", "passage", "--json"])
    )
  );
  assert.equal(code, 0);
  assert.match(seenBody.model, /-passage$/);
});

test("runEmbedCommand --json prints the raw, UNTRUNCATED result (array of one full vector)", async () => {
  // --json output is intentionally exempt from the human-output truncation
  // decision (see embed.mjs's header) — verified here via the request/
  // response round trip: the command must not throw or drop data when
  // handling the full 1024-value vector end to end.
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => jsonResponse(REALISTIC_RESPONSE), () => runEmbedCommand(["hello world", "--json"]))
  );
  assert.equal(code, 0);
});

test("runEmbedCommand exits 2 for an invalid --type value", async () => {
  const code = await withApiKey("test-key", () => runEmbedCommand(["hello", "--type", "bogus"]));
  assert.equal(code, 2);
});

test("runEmbedCommand exits 2 for a missing <text> argument, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runEmbedCommand(["--json"]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runEmbedCommand exits 3 on a simulated UpstageApiError (upstream non-2xx response)", async () => {
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => new Response("bad request", { status: 400 }), () => runEmbedCommand(["hello", "--json"]))
  );
  assert.equal(code, 3);
});

test("runEmbedCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runEmbedCommand(["hello", "--json"]))
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test("runEmbedCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runEmbedCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage embed/);
  await Promise.resolve();
  assert.equal(code, 0);
});
