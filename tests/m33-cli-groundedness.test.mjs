import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGroundednessCommand, formatHuman } from "../src/cli/commands/groundedness.mjs";
import { exitCodeForError } from "../src/cli/lib/upstage-command-helpers.mjs";
import { UpstageApiError } from "../src/upstage/errors.mjs";

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

function chatResponse(content) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), "upstage-cli-groundedness-test-")); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

test("formatHuman renders the grounded label", () => {
  assert.equal(formatHuman({ grounded: "notGrounded", raw: "notGrounded" }), "notGrounded\n");
});

test("runGroundednessCommand succeeds (exit 0) with inline --context/--answer text", async () => {
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = JSON.parse(options.body); return chatResponse("grounded"); },
      () => runGroundednessCommand(["--context", "The sky is blue.", "--answer", "The sky is blue.", "--json"])
    )
  );
  assert.equal(code, 0);
  assert.deepEqual(seenBody.messages, [
    { role: "user", content: "The sky is blue." },
    { role: "assistant", content: "The sky is blue." }
  ]);
});

test("runGroundednessCommand supports @file syntax for both --context and --answer", async () => {
  const contextPath = join(dir, "context.txt");
  const answerPath = join(dir, "answer.txt");
  writeFileSync(contextPath, "The sky is blue.");
  writeFileSync(answerPath, "The sky is blue.");
  let seenBody;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async (_url, options) => { seenBody = JSON.parse(options.body); return chatResponse("grounded"); },
      () => runGroundednessCommand(["--context", `@${contextPath}`, "--answer", `@${answerPath}`, "--json"])
    )
  );
  assert.equal(code, 0);
  assert.deepEqual(seenBody.messages, [
    { role: "user", content: "The sky is blue." },
    { role: "assistant", content: "The sky is blue." }
  ]);
});

test("runGroundednessCommand exits 2 when --context's @file does not exist, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => { calls += 1; return chatResponse("grounded"); },
      () => runGroundednessCommand(["--context", `@${join(dir, "missing.txt")}`, "--answer", "ans"])
    )
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runGroundednessCommand exits 2 for a missing --context flag, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return chatResponse("grounded"); }, () => runGroundednessCommand(["--answer", "ans"]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runGroundednessCommand exits 2 for a missing --answer flag, and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey("test-key", () =>
    withMockFetch(async () => { calls += 1; return chatResponse("grounded"); }, () => runGroundednessCommand(["--context", "ctx"]))
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("runGroundednessCommand exits 4 when UPSTAGE_API_KEY is not configured (after arg validation passes), and never touches the network", async () => {
  let calls = 0;
  const code = await withApiKey(undefined, () =>
    withMockFetch(
      async () => { calls += 1; return chatResponse("grounded"); },
      () => runGroundednessCommand(["--context", "ctx", "--answer", "ans", "--json"])
    )
  );
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

// EXIT-CODE MAPPING NOTE (see groundedness.mjs's own header, and
// upstage-command-helpers.mjs's exitCodeForError doc comment): unlike the
// other six commands, checkGroundedness() calls UpstageAdapter.complete()
// directly rather than going through upstageRequest()/client.mjs, so a real
// upstream API failure surfaces as a plain Error, NOT an UpstageApiError —
// there is no way to trigger a genuine UpstageApiError through
// checkGroundedness()'s real call path (confirmed: it never imports or
// throws that class). That means this command's real failure path exits 1
// ("general/unexpected error"), asserted below, while the *mapping logic*
// itself (shared by all seven commands, in upstage-command-helpers.mjs) is
// verified directly against a constructed UpstageApiError instance — proving
// that IF checkGroundedness() ever were changed to throw one, this command
// would correctly exit 3, without needing module-mocking machinery this repo
// doesn't have available.
test("runGroundednessCommand's real failure path exits 1 (checkGroundedness throws plain Error, not UpstageApiError)", async () => {
  const code = await withApiKey("test-key", () =>
    withMockFetch(
      async () => new Response("server error", { status: 400 }),
      () => runGroundednessCommand(["--context", "ctx", "--answer", "ans", "--json"])
    )
  );
  assert.equal(code, 1);
});

test("exitCodeForError maps a (simulated) UpstageApiError to exit code 3 — the mapping runGroundednessCommand's catch block relies on", () => {
  assert.equal(exitCodeForError(new UpstageApiError("simulated upstream failure"), { fallbackCode: 1 }), 3);
});

test("runGroundednessCommand -h/--help prints usage and exits 0 without touching the network", async () => {
  let code;
  const text = captureStdioSync(() => {
    runGroundednessCommand(["-h"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage groundedness/);
  await Promise.resolve();
  assert.equal(code, 0);
});
