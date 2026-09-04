import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runParseCommand, formatHuman } from "../src/cli/commands/parse.mjs";

// Matches the established pattern (tests/m33-upstage-documents.test.mjs et
// al.): no ESM module-mocking available in this repo's plain `node --test`
// invocation, so mock global.fetch, the actual network boundary underneath
// upstageRequest.
//
// NOTE on what these tests deliberately do NOT do: intercept
// process.stdout/stderr.write around an awaited call. tests/m33-doctor.test.mjs
// documents (and this task's own exploration re-confirmed, empirically) that
// doing so in this repo's `node --test` runner doesn't just corrupt output —
// it can silently drop OTHER tests in the same file from being registered at
// all. So content assertions go through the pure, synchronous `formatHuman()`
// export (fed by a literal result object, no I/O) and through the mocked
// fetch call's own captured request (`seenBody`/`seenUrl`, populated by our
// own mock implementation — not by intercepting global stdio); exit codes are
// asserted on `runParseCommand`'s real return value only.
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

// Synchronous-only capture (mirrors tests/m33-doctor.test.mjs's captureStdio):
// safe because the -h/--help path writes to stdout and resolves without ever
// awaiting real I/O — the capture window never spans an await boundary.
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
test.before(() => { dir = mkdtempSync(join(tmpdir(), "upstage-cli-parse-test-")); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture(name, bytes = Buffer.from("fake-pdf-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const REALISTIC_RESPONSE = {
  elements: [
    { category: "heading1", page: 1, content: { markdown: "# Title", html: "<h1>Title</h1>", text: "Title" } },
    { category: "paragraph", page: 1, content: { markdown: "Body text.", html: "<p>Body text.</p>", text: "Body text." } }
  ]
};

// --- pure formatHuman() content assertions (no I/O) ---

test("formatHuman renders element/page counts and content", () => {
  const text = formatHuman({ elements: [{}, {}], markdown: "# Title\n\nBody.", text: "", pageCount: 3 });
  assert.match(text, /2 element\(s\), 3 page\(s\)/);
  assert.match(text, /# Title/);
});

test("formatHuman falls back to `text` content when `markdown` is empty (format=text case)", () => {
  const text = formatHuman({ elements: [{}], markdown: "", text: "plain text body", pageCount: 1 });
  assert.match(text, /plain text body/);
});

// --- runParseCommand: success path, --json shape verified via the raw result echoed back by our own mock ---

test("runParseCommand --json succeeds (exit 0) against a mocked 2xx response and requests markdown by default", async () => {
  const path = fixture("doc.pdf");
  let seenUrl;
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (url, options) => {
        seenUrl = url;
        seenBody = Buffer.from(options.body).toString("utf8");
        return jsonResponse(REALISTIC_RESPONSE);
      },
      () => runParseCommand([path, "--json"])
    )
  );
  assert.equal(code, 0);
  assert.match(seenUrl, /\/document-digitization$/);
  assert.match(seenBody, /name="output_formats"\r\n\r\n\['markdown'\]/);
  assert.match(seenBody, /name="mode"\r\n\r\nstandard/);
  assert.match(seenBody, /name="ocr"\r\n\r\nauto/);
});

test("runParseCommand maps --format md/html/text onto documents.mjs's format param, and passes --mode/--ocr through", async () => {
  const path = fixture("doc2.pdf");
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = Buffer.from(options.body).toString("utf8"); return jsonResponse(REALISTIC_RESPONSE); },
      () => runParseCommand([path, "--format", "text", "--mode", "enhanced", "--ocr", "force"])
    )
  );
  assert.equal(code, 0);
  assert.match(seenBody, /name="output_formats"\r\n\r\n\['text'\]/);
  assert.match(seenBody, /name="mode"\r\n\r\nenhanced/);
  assert.match(seenBody, /name="ocr"\r\n\r\nforce/);
});

// --- exit code 3: simulated UpstageApiError (upstream non-2xx response) ---

test("runParseCommand exits 3 on a simulated UpstageApiError (upstream non-2xx response)", async () => {
  // status 400 (not 429/5xx) so fetchWithRetry's own retry/backoff logic
  // doesn't kick in — keeps this test fast while still exercising the exact
  // client.mjs code path that throws UpstageApiError on any non-ok response.
  const path = fixture("doc3.pdf");
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => new Response("bad request", { status: 400 }), () => runParseCommand([path, "--json"]))
  );
  assert.equal(code, 3);
});

// --- exit code 2: missing required <file>, invalid enum flags — before any network call ---

test("runParseCommand exits 2 for a missing <file> argument, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runParseCommand(["--json"]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runParseCommand exits 2 for an invalid --format value", async () => {
  const path = fixture("doc4.pdf");
  const code = await withApiKey("test-key", () => runParseCommand([path, "--format", "bogus"]));
  assert.equal(code, 2);
});

test("runParseCommand exits 2 for an invalid --mode value", async () => {
  const path = fixture("doc5.pdf");
  const code = await withApiKey("test-key", () => runParseCommand([path, "--mode", "bogus"]));
  assert.equal(code, 2);
});

test("runParseCommand exits 2 for an invalid --ocr value", async () => {
  const path = fixture("doc6.pdf");
  const code = await withApiKey("test-key", () => runParseCommand([path, "--ocr", "bogus"]));
  assert.equal(code, 2);
});

// --- exit code 4: missing API key, checked AFTER arg validation, BEFORE any network call ---

test("runParseCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  const path = fixture("doc7.pdf");
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(async () => { calls += 1; return jsonResponse(REALISTIC_RESPONSE); }, () => runParseCommand([path, "--json"]))
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test("runParseCommand: a missing <file> (exit 2) takes priority over a missing API key (exit 4)", async () => {
  const code = await withApiKey(undefined, () => runParseCommand(["--json"]));
  assert.equal(code, 2);
});

// --- --help: synchronous-only capture, safe (see captureStdioSync's comment) ---

test("runParseCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runParseCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage parse/);
  await Promise.resolve();
  assert.equal(code, 0);
});
