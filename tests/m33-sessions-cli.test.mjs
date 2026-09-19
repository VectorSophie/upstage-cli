// Tests for `upstage sessions list/show/resume/export` — Task 12.6 of the
// 3.2.0 release plan (src/cli/commands/sessions.mjs), folded together with
// Task 7.13's export-formatting logic (src/runtime/session-export.mjs) per
// the plan's own "or folded into Task 12.6's sessions.mjs" note.
//
// `list`/`show`/`resume`/`export` all read real on-disk session state
// (src/runtime/session.mjs's `sessionRoot()` is hardcoded to
// `os.homedir()/.upstage-cli/sessions` — there's no injection seam to point
// it at a temp dir, unlike e.g. mcp.mjs's `gatherMcp*({cwd})`). So these
// tests create real sessions via `createSession`/`saveSession` (random
// UUIDs — collision with a real user session is not a practical concern)
// and always clean up via `resetSession()` in a `finally` block. `list`'s
// assertions use `.find()`/`.some()` rather than exact-array checks, since
// a real `~/.upstage-cli/sessions` may already contain unrelated sessions.
//
// A fake, distinctive "secret" value for the §8 redaction test — chosen to
// be extremely unlikely to appear anywhere in real output by coincidence,
// same technique as tests/m33-doctor.test.mjs's FAKE_SECRET.
const FAKE_SECRET = "AKIA_FAKE_SECRET_VALUE_12345";

import test from "node:test";
import assert from "node:assert/strict";

import { createSession, saveSession, resetSession } from "../src/runtime/session.mjs";
import { runClassicCli as indexRunClassicCli, parseArgs as indexParseArgs } from "../src/cli/index.mjs";

import {
  gatherSessionsList, formatSessionsListHuman, formatSessionsListJson, runSessionsListCommand,
  gatherSessionsShow, formatShowHuman, formatShowJson, runSessionsShowCommand,
  runSessionsResumeCommand,
  gatherSessionsExport, runSessionsExportCommand,
  __internal as sessionsInternal
} from "../src/cli/commands/sessions.mjs";

import {
  formatSessionAsJson, formatSessionAsJsonl, formatSessionAsMarkdown
} from "../src/runtime/session-export.mjs";

function withSavedSession(build, run) {
  const session = build(createSession(process.cwd()));
  return saveSession(session)
    .then(() => run(session))
    .finally(() => resetSession(session.id));
}

// --- list ---

test("gatherSessionsList / formatSessionsListHuman / formatSessionsListJson", () => {
  return withSavedSession((s) => s, async (session) => {
    const rows = await gatherSessionsList();
    const row = rows.find((r) => r.id === session.id);
    assert.ok(row, "created session should appear in listSessions()");
    assert.equal(row.workspace?.cwd, process.cwd());

    const human = formatSessionsListHuman(rows);
    assert.match(human, /ID\s+UPDATED\s+WORKSPACE/);
    assert.ok(human.includes(session.id));

    const json = JSON.parse(formatSessionsListJson(rows));
    assert.ok(Array.isArray(json));
    assert.ok(json.some((r) => r.id === session.id));
  });
});

test("formatSessionsListHuman reports 'No sessions found.' for an empty list", () => {
  assert.equal(formatSessionsListHuman([]), "No sessions found.\n");
});

test("runSessionsListCommand returns exit code 0 for both human and --json", () => {
  return withSavedSession((s) => s, async () => {
    assert.equal(await runSessionsListCommand([]), 0);
    assert.equal(await runSessionsListCommand(["--json"]), 0);
  });
});

// --- show ---

test("gatherSessionsShow returns a bounded summary (not a full dump) for a found session", () => {
  return withSavedSession(
    (s) => {
      s.history.push({ role: "user", content: "hi", at: Date.now() });
      s.toolResults.push({ tool: "echo", args: {}, result: { ok: true, data: {} }, at: Date.now() });
      return s;
    },
    async (session) => {
      const outcome = await gatherSessionsShow({ id: session.id });
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.result.id, session.id);
      assert.equal(outcome.result.historyCount, 1);
      assert.equal(outcome.result.toolResultsCount, 1);
      assert.equal(outcome.result.workspace?.cwd, process.cwd());

      const human = formatShowHuman(outcome.result);
      assert.ok(human.includes(session.id));
      assert.ok(human.includes("history: 1 entries"));

      const json = JSON.parse(formatShowJson(outcome.result));
      assert.equal(json.id, session.id);
    }
  );
});

test("gatherSessionsShow: missing <id> is a usage error (code 2)", async () => {
  const outcome = await gatherSessionsShow({});
  assert.equal(outcome.code, 2);
  assert.match(outcome.error, /missing required <id>/);
});

test("gatherSessionsShow: unknown <id> is 'session not found' (code 1)", async () => {
  const outcome = await gatherSessionsShow({ id: "definitely-not-a-real-session-id" });
  assert.equal(outcome.code, 1);
  assert.match(outcome.error, /no session found/);
});

test("runSessionsShowCommand exit codes: found=0, missing-id=2, not-found=1", async () => {
  assert.equal(await runSessionsShowCommand([]), 2);
  assert.equal(await runSessionsShowCommand(["nope-not-real"]), 1);
  await withSavedSession((s) => s, async (session) => {
    assert.equal(await runSessionsShowCommand([session.id]), 0);
  });
});

// --- resume: "same code path as `upstage --session <id>`" ---

test("sessions resume's default deps are the EXACT SAME functions index.mjs's --session path uses (reference identity, not reimplementation)", () => {
  assert.equal(sessionsInternal.runClassicCli, indexRunClassicCli);
  assert.equal(sessionsInternal.parseArgs, indexParseArgs);
});

test("sessions resume builds args via parseArgs(['--session', id]) — identical to what --session <id> parses to — and invokes runClassicCli with them", () => {
  return withSavedSession((s) => s, async (session) => {
    const calls = [];
    const code = await runSessionsResumeCommand([session.id], {
      runClassicCli: async (args) => { calls.push(args); }
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);

    // The real parseArgs — same function reference sessions.mjs itself
    // defaults to (see the reference-identity test above) — computing what
    // `upstage --session <id>` would produce, for a direct comparison.
    const expected = indexParseArgs(["--session", session.id]);
    assert.deepEqual(calls[0], expected);
    assert.equal(calls[0].command, "chat");
    assert.equal(calls[0].sessionId, session.id);
  });
});

test("sessions resume forwards extra flags after <id> into the same parseArgs call", () => {
  return withSavedSession((s) => s, async (session) => {
    const calls = [];
    await runSessionsResumeCommand([session.id, "--model", "solar-pro4"], {
      runClassicCli: async (args) => { calls.push(args); }
    });
    const expected = indexParseArgs(["--session", session.id, "--model", "solar-pro4"]);
    assert.deepEqual(calls[0], expected);
    assert.equal(calls[0].model, "solar-pro4");
  });
});

test("sessions resume: missing <id> is a usage error (code 2), never calls runClassicCli", async () => {
  const calls = [];
  const code = await runSessionsResumeCommand([], { runClassicCli: async (a) => calls.push(a) });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
});

test("sessions resume: unknown <id> is 'session not found' (code 1), never calls runClassicCli", async () => {
  const calls = [];
  const code = await runSessionsResumeCommand(["not-a-real-session"], {
    runClassicCli: async (a) => calls.push(a)
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test("sessions resume: only strips the FIRST occurrence of <id> — a flag value equal to the id survives in extraArgv", () => {
  return withSavedSession((s) => s, async (session) => {
    const calls = [];
    // `--parent <id>` happens to carry the same string as the positional
    // session id. A naive `.filter(token => token !== id)` would strip BOTH
    // occurrences; only the positional one should be removed.
    await runSessionsResumeCommand([session.id, "--parent", session.id], {
      runClassicCli: async (args) => { calls.push(args); }
    });
    const expected = indexParseArgs(["--session", session.id, "--parent", session.id]);
    assert.deepEqual(calls[0], expected);
  });
});

// --- export: formats + §8 redaction ---

function sessionWithSecretWriteFile(s) {
  const content = `API_KEY=${FAKE_SECRET}\nother=stuff`;
  const preview = `API_KEY=${FAKE_SECRET}`;
  s.history.push({ role: "user", content: "please write the secret file", at: Date.now() });
  s.history.push({
    role: "assistant",
    content: "Done.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: "secrets.env", content }) }
    }],
    at: Date.now()
  });
  s.history.push({
    role: "tool",
    name: "write_file",
    tool_call_id: "call_1",
    content: JSON.stringify({ path: "secrets.env", bytesWritten: 41, totalLines: 2, preview }),
    at: Date.now()
  });
  s.toolResults.push({
    tool: "write_file",
    args: { path: "secrets.env", content },
    result: { ok: true, data: { path: "secrets.env", bytesWritten: 41, totalLines: 2, preview } },
    at: Date.now()
  });
  return s;
}

test("export (json/jsonl/md): default output never contains a secret-looking write_file body; --include-tool-io includes it", () => {
  return withSavedSession(sessionWithSecretWriteFile, async (session) => {
    for (const format of ["json", "jsonl", "md"]) {
      const outcome = await gatherSessionsExport({ id: session.id, format });
      assert.equal(outcome.error, undefined, `${format} export should succeed`);
      assert.ok(
        !outcome.result.includes(FAKE_SECRET),
        `${format} export (default, no --include-tool-io) must NOT contain the secret`
      );
    }

    const included = await gatherSessionsExport({ id: session.id, format: "json", includeToolIo: true });
    assert.ok(included.result.includes(FAKE_SECRET), "--include-tool-io should include the raw content");
  });
});

// read_document's result carries the full OCR'd/parsed document body under
// `.markdown` — no raw-content field in its args (just a `path`), so only
// the result side needs redacting.
function sessionWithSecretReadDocument(s) {
  const markdown = `# Contract\n\nAPI_KEY=${FAKE_SECRET}\nSigned by Jane Doe`;
  s.history.push({ role: "user", content: "please read the scanned contract", at: Date.now() });
  s.history.push({
    role: "assistant",
    content: "Done.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "read_document", arguments: JSON.stringify({ path: "contract.pdf" }) }
    }],
    at: Date.now()
  });
  s.history.push({
    role: "tool",
    name: "read_document",
    tool_call_id: "call_1",
    content: JSON.stringify({ path: "contract.pdf", elementCount: 3, markdown }),
    at: Date.now()
  });
  s.toolResults.push({
    tool: "read_document",
    args: { path: "contract.pdf" },
    result: { ok: true, data: { path: "contract.pdf", elementCount: 3, markdown } },
    at: Date.now()
  });
  return s;
}

test("export (json/jsonl/md): default output never contains a secret-looking read_document body; --include-tool-io includes it", () => {
  return withSavedSession(sessionWithSecretReadDocument, async (session) => {
    for (const format of ["json", "jsonl", "md"]) {
      const outcome = await gatherSessionsExport({ id: session.id, format });
      assert.equal(outcome.error, undefined, `${format} export should succeed`);
      assert.ok(
        !outcome.result.includes(FAKE_SECRET),
        `${format} export (default, no --include-tool-io) must NOT contain the secret`
      );
    }

    const included = await gatherSessionsExport({ id: session.id, format: "json", includeToolIo: true });
    assert.ok(included.result.includes(FAKE_SECRET), "--include-tool-io should include the raw content");
  });
});

// multi_edit's args.edits[] is a nested array of {oldText, newText,
// replaceAll} — a different shape from edit_file's flat oldText/newText.
function sessionWithSecretMultiEdit(s) {
  const oldText = `API_KEY=${FAKE_SECRET}`;
  const newText = "API_KEY=rotated";
  s.history.push({ role: "user", content: "please rotate the secret", at: Date.now() });
  s.history.push({
    role: "assistant",
    content: "Done.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: {
        name: "multi_edit",
        arguments: JSON.stringify({ path: "secrets.env", edits: [{ oldText, newText, replaceAll: false }] })
      }
    }],
    at: Date.now()
  });
  s.history.push({
    role: "tool",
    name: "multi_edit",
    tool_call_id: "call_1",
    content: JSON.stringify({
      path: "secrets.env",
      applied: 0,
      failed: 1,
      failures: [{ index: 0, oldText: oldText.slice(0, 60), reason: "oldText not found" }]
    }),
    at: Date.now()
  });
  s.toolResults.push({
    tool: "multi_edit",
    args: { path: "secrets.env", edits: [{ oldText, newText, replaceAll: false }] },
    result: {
      ok: true,
      data: {
        path: "secrets.env",
        applied: 0,
        failed: 1,
        failures: [{ index: 0, oldText: oldText.slice(0, 60), reason: "oldText not found" }]
      }
    },
    at: Date.now()
  });
  return s;
}

// apply_patch's args.patch.newContent is nested under `.patch` — yet another
// shape — and its result carries the FULL old/new file bodies plus a
// mirrored rollbackPatch.newContent, not just a `.preview` snippet.
function sessionWithSecretApplyPatch(s) {
  const newContent = `API_KEY=${FAKE_SECRET}\nother=stuff`;
  const previousContent = "API_KEY=old\nother=stuff";
  s.history.push({ role: "user", content: "please apply the patch", at: Date.now() });
  s.history.push({
    role: "assistant",
    content: "Done.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({ patch: { version: 1, path: "secrets.env", newContent } })
      }
    }],
    at: Date.now()
  });
  s.history.push({
    role: "tool",
    name: "apply_patch",
    tool_call_id: "call_1",
    content: JSON.stringify({
      path: "secrets.env",
      applied: true,
      previousContent,
      newContent,
      rollbackPatch: { version: 1, path: "secrets.env", newContent: previousContent }
    }),
    at: Date.now()
  });
  s.toolResults.push({
    tool: "apply_patch",
    args: { patch: { version: 1, path: "secrets.env", newContent } },
    result: {
      ok: true,
      data: {
        path: "secrets.env",
        applied: true,
        previousContent,
        newContent,
        rollbackPatch: { version: 1, path: "secrets.env", newContent: previousContent }
      }
    },
    at: Date.now()
  });
  return s;
}

test("export (json/jsonl/md): default output never contains a secret-looking multi_edit body; --include-tool-io includes it", () => {
  return withSavedSession(sessionWithSecretMultiEdit, async (session) => {
    for (const format of ["json", "jsonl", "md"]) {
      const outcome = await gatherSessionsExport({ id: session.id, format });
      assert.equal(outcome.error, undefined, `${format} export should succeed`);
      assert.ok(
        !outcome.result.includes(FAKE_SECRET),
        `${format} export (default, no --include-tool-io) must NOT contain the secret`
      );
    }

    const included = await gatherSessionsExport({ id: session.id, format: "json", includeToolIo: true });
    assert.ok(included.result.includes(FAKE_SECRET), "--include-tool-io should include the raw content");
  });
});

test("export (json/jsonl/md): default output never contains a secret-looking apply_patch body; --include-tool-io includes it", () => {
  return withSavedSession(sessionWithSecretApplyPatch, async (session) => {
    for (const format of ["json", "jsonl", "md"]) {
      const outcome = await gatherSessionsExport({ id: session.id, format });
      assert.equal(outcome.error, undefined, `${format} export should succeed`);
      assert.ok(
        !outcome.result.includes(FAKE_SECRET),
        `${format} export (default, no --include-tool-io) must NOT contain the secret`
      );
    }

    const included = await gatherSessionsExport({ id: session.id, format: "json", includeToolIo: true });
    assert.ok(included.result.includes(FAKE_SECRET), "--include-tool-io should include the raw content");
  });
});

test("export defaults to --format md when --format is omitted", () => {
  return withSavedSession((s) => s, async (session) => {
    const outcome = await gatherSessionsExport({ id: session.id });
    assert.equal(outcome.error, undefined);
    assert.match(outcome.result, /^# Session /);
  });
});

test("export: missing <id> (code 2), unknown <id> (code 1), bad --format (code 2)", async () => {
  assert.equal((await gatherSessionsExport({})).code, 2);
  assert.equal((await gatherSessionsExport({ id: "nope-not-real" })).code, 1);
  await withSavedSession((s) => s, async (session) => {
    const bad = await gatherSessionsExport({ id: session.id, format: "yaml" });
    assert.equal(bad.code, 2);
    assert.match(bad.error, /unknown --format/);
  });
});

test("runSessionsExportCommand exit codes and --format/--include-tool-io flag parsing", () => {
  return withSavedSession(sessionWithSecretWriteFile, async (session) => {
    assert.equal(await runSessionsExportCommand([]), 2);
    assert.equal(await runSessionsExportCommand(["nope-not-real"]), 1);
    assert.equal(await runSessionsExportCommand([session.id, "--format", "json"]), 0);
    assert.equal(await runSessionsExportCommand([session.id, "--format", "jsonl"]), 0);
    assert.equal(await runSessionsExportCommand([session.id, "--format", "md", "--include-tool-io"]), 0);
  });
});

// --- session-export.mjs: one direct test per format (Task 7.13), pure/fast ---

function sampleSession() {
  const content = `TOP SECRET ${FAKE_SECRET}`;
  return {
    id: "sess-fixture-1",
    createdAt: 1717200000000,
    updatedAt: 1717200500000,
    workspace: { cwd: "/repo" },
    parentSessionId: null,
    history: [
      { role: "user", content: "please write x.txt", at: 1 },
      {
        role: "assistant",
        content: "Sure, writing it now.",
        tool_calls: [{
          id: "call_1", type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "x.txt", content }) }
        }],
        at: 2
      },
      {
        role: "tool", name: "write_file", tool_call_id: "call_1",
        content: JSON.stringify({ path: "x.txt", bytesWritten: 40, totalLines: 1, preview: content }),
        at: 3
      }
    ],
    toolResults: [
      {
        tool: "write_file",
        args: { path: "x.txt", content },
        result: { ok: true, data: { path: "x.txt", bytesWritten: 40, totalLines: 1, preview: content } },
        at: 3
      }
    ],
    appliedPatches: [{ path: "x.txt", verified: true, at: 3 }],
    runtimeEvents: [
      { type: "tool_start", tool: "write_file", args: { path: "x.txt", content }, at: 2 },
      { type: "tool_result", tool: "write_file", ok: true, result: { path: "x.txt", bytesWritten: 40, totalLines: 1, preview: content }, at: 3 },
      { type: "token_usage", totalTokens: 500, promptTokens: 300, completionTokens: 200, at: 4 }
    ]
  };
}

test("formatSessionAsJson: redacted by default, --includeToolIo restores raw content", () => {
  const session = sampleSession();
  const redacted = formatSessionAsJson(session);
  assert.ok(!redacted.includes(FAKE_SECRET));
  assert.ok(redacted.includes("elided"));
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.id, "sess-fixture-1");

  const full = formatSessionAsJson(session, { includeToolIo: true });
  assert.ok(full.includes(FAKE_SECRET));
});

test("formatSessionAsJsonl: one JSON line per history + runtimeEvents entry, tagged, redacted by default", () => {
  const session = sampleSession();
  const out = formatSessionAsJsonl(session);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, session.history.length + session.runtimeEvents.length);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(parsed._kind === "history" || parsed._kind === "runtimeEvent");
  }
  assert.ok(!out.includes(FAKE_SECRET));

  const full = formatSessionAsJsonl(session, { includeToolIo: true });
  assert.ok(full.includes(FAKE_SECRET));
});

test("formatSessionAsMarkdown: genuinely human-readable transcript, redacted by default", () => {
  const session = sampleSession();
  const md = formatSessionAsMarkdown(session);
  assert.match(md, /^# Session sess-fixture-1/);
  assert.match(md, /## Conversation/);
  assert.match(md, /### User/);
  assert.match(md, /### Assistant/);
  assert.match(md, /## Applied Patches/);
  assert.match(md, /## Token Usage/);
  assert.ok(!md.includes(FAKE_SECRET));

  const full = formatSessionAsMarkdown(session, { includeToolIo: true });
  assert.ok(full.includes(FAKE_SECRET));
});

// read_document coverage across all three places a tool call/result can
// appear (toolResults, history, runtimeEvents) — mirrors sampleSession()
// above but for read_document's {path, elementCount, markdown} result shape.
function sampleSessionReadDocument() {
  const markdown = `# Contract\n\nTOP SECRET ${FAKE_SECRET}`;
  return {
    id: "sess-fixture-2",
    createdAt: 1717200000000,
    updatedAt: 1717200500000,
    workspace: { cwd: "/repo" },
    parentSessionId: null,
    history: [
      { role: "user", content: "please read contract.pdf", at: 1 },
      {
        role: "assistant",
        content: "Sure, reading it now.",
        tool_calls: [{
          id: "call_1", type: "function",
          function: { name: "read_document", arguments: JSON.stringify({ path: "contract.pdf" }) }
        }],
        at: 2
      },
      {
        role: "tool", name: "read_document", tool_call_id: "call_1",
        content: JSON.stringify({ path: "contract.pdf", elementCount: 2, markdown }),
        at: 3
      }
    ],
    toolResults: [
      {
        tool: "read_document",
        args: { path: "contract.pdf" },
        result: { ok: true, data: { path: "contract.pdf", elementCount: 2, markdown } },
        at: 3
      }
    ],
    appliedPatches: [],
    runtimeEvents: [
      { type: "tool_start", tool: "read_document", args: { path: "contract.pdf" }, at: 2 },
      { type: "tool_result", tool: "read_document", ok: true, result: { path: "contract.pdf", elementCount: 2, markdown }, at: 3 }
    ]
  };
}

test("read_document: redacted consistently across toolResults, history, and runtimeEvents (json/jsonl/md)", () => {
  const session = sampleSessionReadDocument();

  const json = formatSessionAsJson(session);
  assert.ok(!json.includes(FAKE_SECRET));
  assert.ok(json.includes("document content elided"));
  const parsed = JSON.parse(json);
  // toolResults and runtimeEvents (not just history) must both be redacted.
  assert.ok(!JSON.stringify(parsed.toolResults).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(parsed.runtimeEvents).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(parsed.history).includes(FAKE_SECRET));

  const jsonl = formatSessionAsJsonl(session);
  assert.ok(!jsonl.includes(FAKE_SECRET));

  const md = formatSessionAsMarkdown(session);
  assert.ok(!md.includes(FAKE_SECRET));

  const full = formatSessionAsJson(session, { includeToolIo: true });
  assert.ok(full.includes(FAKE_SECRET));
});
