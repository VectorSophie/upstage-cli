import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runClassifyCommand, formatHuman } from "../src/cli/commands/classify.mjs";

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

let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), "upstage-cli-classify-test-")); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture(name, bytes = Buffer.from("fake-pdf-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const REALISTIC_RESPONSE = {
  tool_calls: [
    { function: { arguments: JSON.stringify({ document_type: { label: "invoice", confidence_score: 0.87 } }) } }
  ]
};

test("formatHuman renders label and confidence", () => {
  assert.match(formatHuman({ label: "invoice", confidence: 0.87 }), /invoice \(confidence: 0\.87\)/);
});

test("formatHuman renders just the label when confidence is absent", () => {
  assert.equal(formatHuman({ label: "invoice", confidence: undefined }), "invoice\n");
});

test("runClassifyCommand succeeds (exit 0) and splits --categories on commas", async () => {
  const path = fixture("doc.pdf");
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = Buffer.from(options.body).toString("utf8"); return jsonResponse(REALISTIC_RESPONSE); },
      () => runClassifyCommand([path, "--categories", "invoice, contract , receipt", "--json"])
    )
  );
  assert.equal(code, 0);
  const match = seenBody.match(/name="response_format"\r\n\r\n([\s\S]*?)\r\n--/);
  assert.ok(match, "response_format field should be present");
  const responseFormat = JSON.parse(match[1]);
  assert.deepEqual(responseFormat.json_schema.schema.properties.document_type.oneOf, [
    { const: "invoice" },
    { const: "contract" },
    { const: "receipt" }
  ]);
});

test("runClassifyCommand exits 3 on a simulated UpstageApiError (upstream non-2xx response)", async () => {
  const path = fixture("doc2.pdf");
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => new Response("bad request", { status: 400 }),
      () => runClassifyCommand([path, "--categories", "a,b", "--json"])
    )
  );
  assert.equal(code, 3);
});

test("runClassifyCommand exits 2 for a missing <file> argument, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); },
      () => runClassifyCommand(["--categories", "a,b"])
    )
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runClassifyCommand exits 2 for a missing --categories flag, and never touches the network", async () => {
  const path = fixture("doc3.pdf");
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runClassifyCommand([path]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runClassifyCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  const path = fixture("doc4.pdf");
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(
      async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); },
      () => runClassifyCommand([path, "--categories", "a,b", "--json"])
    )
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test("runClassifyCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runClassifyCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage classify/);
  await Promise.resolve();
  assert.equal(code, 0);
});
