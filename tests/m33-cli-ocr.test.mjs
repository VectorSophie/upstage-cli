import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOcrCommand, formatHuman } from "../src/cli/commands/ocr.mjs";

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
test.before(() => { dir = mkdtempSync(join(tmpdir(), "upstage-cli-ocr-test-")); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture(name, bytes = Buffer.from("fake-png-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const REALISTIC_RESPONSE = { elements: [{ page: 1, content: { markdown: "scanned text" } }] };

test("formatHuman renders element/page counts and markdown content", () => {
  const text = formatHuman({ elements: [{}], markdown: "scanned text", pageCount: 1 });
  assert.match(text, /1 element\(s\), 1 page\(s\)/);
  assert.match(text, /scanned text/);
});

test("runOcrCommand succeeds (exit 0) against a mocked 2xx response and sends model=ocr", async () => {
  const path = fixture("scan.png");
  let seenUrl;
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (url, options) => {
        seenUrl = url;
        seenBody = Buffer.from(options.body).toString("utf8");
        return jsonResponse(REALISTIC_RESPONSE);
      },
      () => runOcrCommand([path, "--json"])
    )
  );
  assert.equal(code, 0);
  assert.match(seenUrl, /\/document-digitization$/);
  assert.match(seenBody, /name="model"\r\n\r\nocr/);
  assert.doesNotMatch(seenBody, /name="ocr"\r\n/);
});

test("runOcrCommand exits 3 on a simulated UpstageApiError (upstream non-2xx response)", async () => {
  const path = fixture("scan2.png");
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => new Response("bad request", { status: 400 }), () => runOcrCommand([path, "--json"]))
  );
  assert.equal(code, 3);
});

test("runOcrCommand exits 2 for a missing <file> argument, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runOcrCommand(["--json"]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runOcrCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  const path = fixture("scan3.png");
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runOcrCommand([path, "--json"]))
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test("runOcrCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runOcrCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage ocr/);
  await Promise.resolve();
  assert.equal(code, 0);
});
