import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSchemaCommand, formatHuman } from "../src/cli/commands/schema.mjs";
import { MAX_SCHEMA_SAMPLE_PATHS } from "../src/upstage/extraction.mjs";

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
test.before(() => { dir = mkdtempSync(join(tmpdir(), "upstage-cli-schema-test-")); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture(name, bytes = Buffer.from("fake-pdf-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const SAMPLE_SCHEMA = { type: "object", properties: { total: { type: "number" } } };
const REALISTIC_RESPONSE = { schema: SAMPLE_SCHEMA };

test("formatHuman pretty-prints the generated schema", () => {
  const text = formatHuman({ schema: SAMPLE_SCHEMA });
  assert.match(text, /"type": "object"/);
});

test("runSchemaCommand succeeds (exit 0) with a single sample file", async () => {
  const path = fixture("doc.pdf");
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => jsonResponse(REALISTIC_RESPONSE), () => runSchemaCommand([path, "--json"]))
  );
  assert.equal(code, 0);
});

test("runSchemaCommand succeeds (exit 0) with the maximum of 3 sample files", async () => {
  const paths = [fixture("a.pdf"), fixture("b.pdf"), fixture("c.pdf")];
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => jsonResponse(REALISTIC_RESPONSE), () => runSchemaCommand([...paths, "--json"]))
  );
  assert.equal(code, 0);
});

test("runSchemaCommand exits 2 for zero <files...> arguments, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runSchemaCommand(["--json"]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test(`runSchemaCommand exits 2 for more than ${MAX_SCHEMA_SAMPLE_PATHS} <files...> arguments, and never touches the network`, async () => {
  const paths = [fixture("d.pdf"), fixture("e.pdf"), fixture("f.pdf"), fixture("g.pdf")];
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runSchemaCommand(paths))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runSchemaCommand exits 3 on a simulated UpstageApiError (upstream non-2xx response)", async () => {
  const path = fixture("h.pdf");
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => new Response("bad request", { status: 400 }), () => runSchemaCommand([path, "--json"]))
  );
  assert.equal(code, 3);
});

test("runSchemaCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  const path = fixture("i.pdf");
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runSchemaCommand([path, "--json"]))
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test("runSchemaCommand: too many files (exit 2) takes priority over a missing API key (exit 4)", async () => {
  const paths = [fixture("j.pdf"), fixture("k.pdf"), fixture("l.pdf"), fixture("m.pdf")];
  const code = await withApiKey(undefined, () => runSchemaCommand(paths));
  assert.equal(code, 2);
});

test("runSchemaCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runSchemaCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage schema/);
  await Promise.resolve();
  assert.equal(code, 0);
});
