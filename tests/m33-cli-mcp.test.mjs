// Tests for `upstage mcp list/status/test/tools/show` — Task 12.4 of the
// 3.2.0 release plan (src/cli/commands/mcp.mjs).
//
// The `gather*` functions accept `{ cwd, settings }` directly (bypassing
// `loadSettings()`'s real on-disk cascade with `settings: {}`) so tests can
// point at a temp `.mcp.json` fixture deterministically, same pattern as
// tests/m33-doctor.test.mjs uses for `runDoctorChecks({ cwd })`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import {
  gatherMcpList, formatListHuman, formatListJson, runMcpListCommand,
  gatherMcpStatus, formatStatusHuman, formatStatusJson, runMcpStatusCommand,
  gatherMcpTestResults, formatTestHuman, formatTestJson, runMcpTestCommand,
  gatherMcpTools, formatToolsHuman, formatToolsJson, runMcpToolsCommand,
  gatherMcpShow, formatShowHuman, formatShowJson
} from "../src/cli/commands/mcp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_STDIO = join(__dirname, "fixtures", "mock-mcp-server.mjs");

// A fake, distinctive "secret" value — alphanumeric/underscore only (safe to
// use verbatim as a regex literal), chosen to be extremely unlikely to
// appear anywhere in real output by coincidence. Same technique as
// tests/m33-doctor.test.mjs's FAKE_SECRET.
const FAKE_SECRET = "sk_TOTALLY_FAKE_MCP_SECRET_zzz777abc";

function withTempDir(run) {
  return mkdtemp(join(tmpdir(), "mcp-cli-")).then((dir) =>
    Promise.resolve()
      .then(() => run(dir))
      .finally(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  );
}

// For the `runMcpXCommand` CLI entry points, which read `process.cwd()`
// themselves rather than taking a `cwd` parameter (unlike the `gatherMcp*`
// core functions above). Same technique as tests/m33-doctor.test.mjs's
// `withCwd`. Deliberately NOT paired with stdout capture across these same
// awaits — see that file's own comment on why intercepting
// `process.stdout.write` across a real async boundary in `node --test`
// risks corrupting the TAP stream for other tests; exit-code assertions
// only, content assertions go through the already-covered pure
// `format*Human`/`format*Json` functions instead.
function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

/** A minimal Streamable-HTTP MCP server exposing one tool ("ping"), same
 *  shape as tests/m19-mcp-http.test.mjs's mock server. */
function startMockHttpServer() {
  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-http", version: "1.0" } }
        }));
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { tools: [{ name: "ping", description: "Replies pong", inputSchema: { type: "object" } }] }
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/mcp`, server });
    });
  });
}

/**
 * The required fixture: three configured servers —
 *   stdio-ok      → stdio, connects successfully (tests/fixtures/mock-mcp-server.mjs, 2 tools)
 *   http-ok       → http, connects successfully (1 tool)
 *   stdio-broken  → stdio, fails to connect (nonexistent binary)
 */
function withThreeServerFixture(run) {
  return withTempDir(async (dir) => {
    const { url, server } = await startMockHttpServer();
    try {
      await writeFile(join(dir, ".mcp.json"), JSON.stringify({
        mcpServers: {
          "stdio-ok": { command: process.execPath, args: [MOCK_STDIO] },
          "http-ok": { url },
          "stdio-broken": { command: "this-binary-does-not-exist-mcp-cli-test", args: [] }
        }
      }));
      await run(dir);
    } finally {
      server.close();
    }
  });
}

/** Same shape as `withThreeServerFixture` but with ONLY the two servers
 *  that connect successfully — used to exercise `runMcpTestCommand`'s
 *  all-pass exit-code path (0), which the 3-server fixture can never hit
 *  since it always includes a deliberately-broken server. */
function withTwoGoodServersFixture(run) {
  return withTempDir(async (dir) => {
    const { url, server } = await startMockHttpServer();
    try {
      await writeFile(join(dir, ".mcp.json"), JSON.stringify({
        mcpServers: {
          "stdio-ok": { command: process.execPath, args: [MOCK_STDIO] },
          "http-ok": { url }
        }
      }));
      await run(dir);
    } finally {
      server.close();
    }
  });
}

// ── list: the required 3-server fixture ─────────────────────────────────

test("mcp list: a failing stdio server does NOT abort the listing — the other two still show", () =>
  withThreeServerFixture(async (dir) => {
    const rows = await gatherMcpList({ cwd: dir, settings: {} });
    assert.equal(rows.length, 3, "the failing server must still appear as a row, not be dropped");

    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    assert.equal(byName["stdio-ok"].status, "connected");
    assert.equal(byName["stdio-ok"].transport, "stdio");
    assert.equal(byName["stdio-ok"].toolCount, 2); // add, echo

    assert.equal(byName["http-ok"].status, "connected");
    assert.equal(byName["http-ok"].transport, "http");
    assert.equal(byName["http-ok"].toolCount, 1); // ping

    assert.equal(byName["stdio-broken"].status, "failed");
    assert.equal(byName["stdio-broken"].transport, "stdio");
    assert.equal(byName["stdio-broken"].toolCount, null);
  })
);

test("mcp list human table: NAME TRANSPORT STATUS TOOLS header, failed row shows STATUS=failed TOOLS=-", () =>
  withThreeServerFixture(async (dir) => {
    const rows = await gatherMcpList({ cwd: dir, settings: {} });
    const text = formatListHuman(rows);
    assert.match(text, /NAME\s+TRANSPORT\s+STATUS\s+TOOLS/);
    assert.match(text, /stdio-ok\s+stdio\s+connected\s+2/);
    assert.match(text, /http-ok\s+http\s+connected\s+1/);
    assert.match(text, /stdio-broken\s+stdio\s+failed\s+-/);
  })
);

test("mcp list --json: array of {name, transport, status, toolCount}; failed server has toolCount null, not omitted", () =>
  withThreeServerFixture(async (dir) => {
    const rows = await gatherMcpList({ cwd: dir, settings: {} });
    const parsed = JSON.parse(formatListJson(rows));
    assert.equal(parsed.length, 3);
    const broken = parsed.find((r) => r.name === "stdio-broken");
    assert.ok(broken);
    assert.equal(broken.status, "failed");
    assert.equal(broken.toolCount, null);
    const ok = parsed.find((r) => r.name === "stdio-ok");
    assert.equal(ok.status, "connected");
    assert.equal(ok.toolCount, 2);
  })
);

test("mcp list: no configured servers produces an empty (not erroring) result", () =>
  withTempDir(async (dir) => {
    const rows = await gatherMcpList({ cwd: dir, settings: {} });
    assert.deepEqual(rows, []);
    assert.match(formatListHuman(rows), /No MCP servers configured/);
  })
);

test("runMcpListCommand: --help prints usage and exits 0 without connecting to anything", async () => {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  let code;
  try {
    code = await runMcpListCommand(["--help"]);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(out.join(""), /Usage: upstage mcp list/);
});

// ── status: narrower single-line-per-server summary ─────────────────────

test("mcp status: connected/failed per server, genuinely narrower than list (no transport/toolCount fields)", () =>
  withThreeServerFixture(async (dir) => {
    const rows = await gatherMcpStatus({ cwd: dir, settings: {} });
    assert.equal(rows.length, 3);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    assert.equal(byName["stdio-ok"], "connected");
    assert.equal(byName["http-ok"], "connected");
    assert.equal(byName["stdio-broken"], "failed");
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["name", "status"]);
    }
  })
);

test("mcp status human output: exactly one line per configured server", () =>
  withThreeServerFixture(async (dir) => {
    const rows = await gatherMcpStatus({ cwd: dir, settings: {} });
    const lines = formatStatusHuman(rows).trim().split("\n");
    assert.equal(lines.length, 3);
  })
);

test("mcp status --json round-trips to [{name, status}]", () =>
  withThreeServerFixture(async (dir) => {
    const rows = await gatherMcpStatus({ cwd: dir, settings: {} });
    const parsed = JSON.parse(formatStatusJson(rows));
    assert.equal(parsed.length, 3);
    assert.ok(parsed.every((r) => "name" in r && "status" in r));
  })
);

test("runMcpStatusCommand: real exit code 0 for both the plain and --json output branches", () =>
  withThreeServerFixture((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runMcpStatusCommand([]), 0);
      assert.equal(await runMcpStatusCommand(["--json"]), 0);
    })
  )
);

// ── test: re-run connection for one or all servers, real error messages ──

test("mcp test <name>: pass for a working stdio server", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTestResults({ cwd: dir, settings: {}, name: "stdio-ok" });
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.results[0].status, "pass");
    assert.equal(outcome.results[0].error, null);
  })
);

test("mcp test <name>: failure reports the ACTUAL underlying error, not a bare 'failed'", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTestResults({ cwd: dir, settings: {}, name: "stdio-broken" });
    assert.equal(outcome.results.length, 1);
    const r = outcome.results[0];
    assert.equal(r.status, "fail");
    assert.ok(r.error && r.error.length > 0, "expected a non-empty error message");
    assert.notEqual(r.error.toLowerCase(), "failed");
    // StdioMcpClient's real spawn-failure message names the server and the
    // failure mode — this is the "actual error message" the task requires.
    assert.match(r.error, /stdio-broken|failed to start|ENOENT|exited/i);
    // Stronger check than the regex above: config.mjs's raw onLog message is
    // `could not connect server '<name>': <the actual message>` — assert
    // connectOne()'s prefix-stripping actually ran (r.error must NOT still
    // start with that raw prefix). Without this, a regression that silently
    // broke the stripping would still pass the regex above, since all of
    // those substrings also appear inside the un-stripped raw message.
    assert.doesNotMatch(r.error, /^could not connect server/);
  })
);

test("mcp test with no <name>: tests all configured servers, mixed pass/fail, each with its own status", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTestResults({ cwd: dir, settings: {} });
    assert.equal(outcome.results.length, 3);
    const byName = Object.fromEntries(outcome.results.map((r) => [r.name, r.status]));
    assert.equal(byName["stdio-ok"], "pass");
    assert.equal(byName["http-ok"], "pass");
    assert.equal(byName["stdio-broken"], "fail");
  })
);

test("mcp test <unknown-name>: usage error (code 2), does not attempt any connection", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTestResults({ cwd: dir, settings: {}, name: "does-not-exist" });
    assert.equal(outcome.code, 2);
    assert.match(outcome.error, /does-not-exist/);
  })
);

test("formatTestHuman/formatTestJson surface the error text for a failed server", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTestResults({ cwd: dir, settings: {}, name: "stdio-broken" });
    const human = formatTestHuman(outcome.results);
    assert.match(human, /stdio-broken/);
    assert.match(human, new RegExp(outcome.results[0].error.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const json = JSON.parse(formatTestJson(outcome.results));
    assert.equal(json[0].error, outcome.results[0].error);
  })
);

// The exact line this exercises — `runMcpTestCommand`'s deliberate
// deviation from doctor's "checks are data, always exit 0" convention
// (`results.every((r) => r.status === "pass") ? 0 : 1`) — had zero direct
// end-to-end coverage before these four tests: everything above calls
// `gatherMcpTestResults` (the data-gathering core), never the CLI entry
// point itself, so a regression in that exit-code line would have gone
// uncaught by this suite.

test("runMcpTestCommand: real exit code 0 when every targeted server passes", () =>
  withTwoGoodServersFixture((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runMcpTestCommand([]), 0);
    })
  )
);

test("runMcpTestCommand: real exit code 1 when at least one targeted server fails", () =>
  withThreeServerFixture((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runMcpTestCommand([]), 1);
    })
  )
);

test("runMcpTestCommand: real exit code 0 with zero configured servers (no early-return needed — vacuous .every())", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runMcpTestCommand([]), 0);
    })
  )
);

test("runMcpTestCommand: --json output branch still returns the same real exit codes", () =>
  withThreeServerFixture((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runMcpTestCommand(["--json"]), 1, "mixed pass/fail across all servers");
      assert.equal(await runMcpTestCommand(["stdio-ok", "--json"]), 0, "single passing server");
      assert.equal(await runMcpTestCommand(["stdio-broken", "--json"]), 1, "single failing server");
    })
  )
);

// ── tools: connect to one server, list its tools ─────────────────────────

test("mcp tools <name>: lists tool names/descriptions/count for a stdio server", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTools({ cwd: dir, settings: {}, name: "stdio-ok" });
    assert.ok(outcome.result, "expected a result, not an error");
    assert.equal(outcome.result.server, "stdio-ok");
    assert.equal(outcome.result.toolCount, 2);
    assert.deepEqual(outcome.result.tools.map((t) => t.name).sort(), ["add", "echo"]);
    assert.ok(outcome.result.tools.every((t) => typeof t.description === "string" && t.description.length > 0));
  })
);

test("mcp tools <name>: lists tools for an http server too", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTools({ cwd: dir, settings: {}, name: "http-ok" });
    assert.equal(outcome.result.toolCount, 1);
    assert.equal(outcome.result.tools[0].name, "ping");
  })
);

test("mcp tools <name>: connection failure surfaces the real error, code 1 (not a usage error)", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTools({ cwd: dir, settings: {}, name: "stdio-broken" });
    assert.equal(outcome.code, 1);
    assert.match(outcome.error, /stdio-broken/);
  })
);

test("mcp tools <unknown-name>: usage error, code 2", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTools({ cwd: dir, settings: {}, name: "does-not-exist" });
    assert.equal(outcome.code, 2);
  })
);

test("mcp tools with no name at all: usage error, code 2", async () => {
  const outcome = await gatherMcpTools({ cwd: process.cwd(), settings: {} });
  assert.equal(outcome.code, 2);
});

test("formatToolsHuman lists each tool with its description and a count line", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpTools({ cwd: dir, settings: {}, name: "stdio-ok" });
    const text = formatToolsHuman(outcome.result);
    assert.match(text, /2 tools/);
    assert.match(text, /add/);
    assert.match(text, /echo/);
    const json = JSON.parse(formatToolsJson(outcome.result));
    assert.equal(json.toolCount, 2);
  })
);

test("runMcpToolsCommand: real exit codes — 0 for a working server (plain and --json), 2 for missing name, 1 for a connection failure", () =>
  withThreeServerFixture((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runMcpToolsCommand(["stdio-ok"]), 0);
      assert.equal(await runMcpToolsCommand(["stdio-ok", "--json"]), 0);
      assert.equal(await runMcpToolsCommand([]), 2, "missing <name> is a usage error");
      assert.equal(await runMcpToolsCommand(["does-not-exist"]), 2, "unknown <name> is a usage error");
      assert.equal(await runMcpToolsCommand(["stdio-broken"]), 1, "a real connection failure is not a usage error");
    })
  )
);

// ── show: security-critical — NEVER a real secret value, adversarial ─────

test("mcp show: a fake secret in a stdio server's env is absent from result, human output, AND json output", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "secret-stdio": {
          command: "irrelevant-never-invoked-by-show",
          args: ["--flag", "value"],
          env: { OPENAI_API_KEY: FAKE_SECRET, PLAIN_LOOKING_VAR: "also-must-be-redacted" }
        }
      }
    }));

    const outcome = await gatherMcpShow({ cwd: dir, settings: {}, name: "secret-stdio" });
    assert.ok(outcome.result, "expected a result, not an error");

    // Adversarial: scan the ENTIRE serialized result, not just the one
    // field we expect to be redacted — catches a leak anywhere in the shape.
    const resultText = JSON.stringify(outcome.result);
    assert.doesNotMatch(resultText, new RegExp(FAKE_SECRET));

    // Key names survive (so the user can tell WHICH vars are configured);
    // only the values are replaced.
    assert.equal(outcome.result.env.OPENAI_API_KEY, "***");
    assert.equal(outcome.result.env.PLAIN_LOOKING_VAR, "***");
    assert.ok("OPENAI_API_KEY" in outcome.result.env);

    const human = formatShowHuman(outcome.result);
    const json = formatShowJson(outcome.result);
    assert.doesNotMatch(human, new RegExp(FAKE_SECRET));
    assert.doesNotMatch(json, new RegExp(FAKE_SECRET));
    assert.match(human, /OPENAI_API_KEY: \*\*\*/);
  })
);

test("mcp show: a fake secret in an http server's headers is absent from result, human output, AND json output", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "secret-http": {
          url: "https://example.invalid/mcp",
          headers: { Authorization: `Bearer ${FAKE_SECRET}`, "X-Api-Key": FAKE_SECRET }
        }
      }
    }));

    const outcome = await gatherMcpShow({ cwd: dir, settings: {}, name: "secret-http" });
    assert.ok(outcome.result);

    const resultText = JSON.stringify(outcome.result);
    assert.doesNotMatch(resultText, new RegExp(FAKE_SECRET));

    assert.equal(outcome.result.headers.Authorization, "***");
    assert.equal(outcome.result.headers["X-Api-Key"], "***");

    const human = formatShowHuman(outcome.result);
    const json = formatShowJson(outcome.result);
    assert.doesNotMatch(human, new RegExp(FAKE_SECRET));
    assert.doesNotMatch(json, new RegExp(FAKE_SECRET));
    // The url itself is not a secret in this codebase's threat model (it's
    // routing info, not a credential) and IS expected to be visible.
    assert.match(human, /url: https:\/\/example\.invalid\/mcp/);
  })
);

test("mcp show never connects — a stdio command that would throw if spawned is still shown safely", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "never-spawned": { command: "this-binary-does-not-exist-mcp-show-test", args: [], env: { SECRET: FAKE_SECRET } }
      }
    }));
    const outcome = await gatherMcpShow({ cwd: dir, settings: {}, name: "never-spawned" });
    assert.ok(outcome.result);
    assert.equal(outcome.result.command, "this-binary-does-not-exist-mcp-show-test");
    assert.equal(outcome.result.env.SECRET, "***");
  })
);

test("mcp show <unknown-name>: usage error, code 2", () =>
  withThreeServerFixture(async (dir) => {
    const outcome = await gatherMcpShow({ cwd: dir, settings: {}, name: "does-not-exist" });
    assert.equal(outcome.code, 2);
  })
);

test("mcp show with no name at all: usage error, code 2", async () => {
  const outcome = await gatherMcpShow({ cwd: process.cwd(), settings: {} });
  assert.equal(outcome.code, 2);
});

// ── timeout: a hanging stdio server must not hang the command ────────────

test("mcp list does not hang on a stdio server that never responds — bounded by the connect timeout, not indefinite", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "hangs-forever": {
          // Spawns, never touches stdin/stdout — the client's initialize
          // request must time out on its own request-level timer rather
          // than waiting forever.
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 100000);"]
        }
      }
    }));

    const start = Date.now();
    const rows = await gatherMcpList({ cwd: dir, settings: {} });
    const elapsedMs = Date.now() - start;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    // A generous multiple of the 5s connect timeout to absorb CI slop —
    // the point is "bounded", not "exactly 5000ms". A real hang would never
    // resolve at all, so even a loose bound here proves the timeout fired.
    assert.ok(elapsedMs < 20000, `expected gatherMcpList to return well under 20s, took ${elapsedMs}ms`);
  })
);
