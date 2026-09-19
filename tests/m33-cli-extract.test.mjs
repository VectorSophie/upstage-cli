import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExtractCommand, formatHuman } from "../src/cli/commands/extract.mjs";

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
test.before(() => { dir = mkdtempSync(join(tmpdir(), "upstage-cli-extract-test-")); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture(name, bytes = Buffer.from("fake-pdf-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const SAMPLE_SCHEMA = { title: "invoice_schema", type: "object", properties: { total: { type: "number" } } };

const REALISTIC_RESPONSE = {
  tool_calls: [{ function: { arguments: JSON.stringify({ total: 42.5, vendor: "Acme" }) } }]
};

test("formatHuman pretty-prints the extracted data object", () => {
  const text = formatHuman({ total: 42.5, vendor: "Acme" });
  assert.match(text, /"total": 42\.5/);
  assert.match(text, /"vendor": "Acme"/);
});

test("runExtractCommand succeeds (exit 0) with an inline --schema JSON value", async () => {
  const path = fixture("doc.pdf");
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = Buffer.from(options.body).toString("utf8"); return jsonResponse(REALISTIC_RESPONSE); },
      () => runExtractCommand([path, "--schema", JSON.stringify(SAMPLE_SCHEMA), "--json"])
    )
  );
  assert.equal(code, 0);
  const match = seenBody.match(/name="response_format"\r\n\r\n([\s\S]*?)\r\n--/);
  assert.ok(match, "response_format field should be present");
  assert.equal(JSON.parse(match[1]).json_schema.name, "invoice_schema");
});

test("runExtractCommand supports @file syntax for --schema (reads and parses the file)", async () => {
  const path = fixture("doc2.pdf");
  const schemaPath = join(dir, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(SAMPLE_SCHEMA));
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = Buffer.from(options.body).toString("utf8"); return jsonResponse(REALISTIC_RESPONSE); },
      () => runExtractCommand([path, "--schema", `@${schemaPath}`, "--json"])
    )
  );
  assert.equal(code, 0);
  const match = seenBody.match(/name="response_format"\r\n\r\n([\s\S]*?)\r\n--/);
  assert.equal(JSON.parse(match[1]).json_schema.name, "invoice_schema");
});

test("runExtractCommand exits 2 for malformed inline JSON in --schema, and never touches the network", async () => {
  const path = fixture("doc3.pdf");
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); },
      () => runExtractCommand([path, "--schema", "{not valid json"])
    )
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runExtractCommand exits 2 when --schema's @file does not exist, and never touches the network", async () => {
  const path = fixture("doc4.pdf");
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); },
      () => runExtractCommand([path, "--schema", `@${join(dir, "does-not-exist.json")}`])
    )
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runExtractCommand exits 2 for a missing --schema flag, and never touches the network", async () => {
  const path = fixture("doc5.pdf");
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runExtractCommand([path]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runExtractCommand exits 2 for a missing <file> argument", async () => {
  const code = await withApiKey("test-key", () => runExtractCommand(["--schema", JSON.stringify(SAMPLE_SCHEMA)]));
  assert.equal(code, 2);
});

test("runExtractCommand exits 3 on a simulated UpstageApiError (upstream non-2xx response)", async () => {
  const path = fixture("doc6.pdf");
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => new Response("bad request", { status: 400 }),
      () => runExtractCommand([path, "--schema", JSON.stringify(SAMPLE_SCHEMA), "--json"])
    )
  );
  assert.equal(code, 3);
});

test("runExtractCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  const path = fixture("doc7.pdf");
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(
      async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); },
      () => runExtractCommand([path, "--schema", JSON.stringify(SAMPLE_SCHEMA), "--json"])
    )
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test("runExtractCommand: malformed --schema (exit 2) takes priority over a missing API key (exit 4)", async () => {
  const path = fixture("doc8.pdf");
  const code = await withApiKey(undefined, () => runExtractCommand([path, "--schema", "{not valid"]));
  assert.equal(code, 2);
});

test("runExtractCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runExtractCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage extract/);
  await Promise.resolve();
  assert.equal(code, 0);
});
