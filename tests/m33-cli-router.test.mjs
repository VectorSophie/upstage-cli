import test from "node:test";
import assert from "node:assert/strict";

import { COMMANDS, dispatch, isRouterCommand } from "../src/cli/router.mjs";
import { parseCliArgs } from "../src/config/cli-args.mjs";

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  return {
    out,
    err,
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  };
}

// --- dispatch to a namespaced leaf ---

test("dispatch routes a namespaced leaf command to its handler", async () => {
  // Uses "mcp add" (still a stub) rather than "mcp list" — Task 12.4
  // replaced list/status/test/tools/show with real implementations, which
  // are covered separately by tests/m33-cli-mcp.test.mjs.
  const io = captureStdio();
  try {
    const code = await dispatch(["mcp", "add"]);
    assert.equal(code, 1); // stub handler: not-yet-implemented, non-zero exit
    assert.match(io.err.join(""), /upstage mcp add: not yet implemented/);
  } finally {
    io.restore();
  }
});

test("dispatch routes a top-level leaf command (no subcommands) to its handler", async () => {
  // Uses "migrate" (still a stub as of this test) rather than "doctor"/
  // "version" — Task 12.3 replaced the doctor stub with a real
  // implementation (covered by tests/m33-doctor.test.mjs) and Task 12.9
  // replaced the version stub with a real implementation (covered by
  // tests/m33-version-cli.test.mjs). "migrate" (Task 7.23) remains a stub.
  const io = captureStdio();
  try {
    const code = await dispatch(["migrate"]);
    assert.equal(code, 1);
    assert.match(io.err.join(""), /upstage migrate: not yet implemented/);
  } finally {
    io.restore();
  }
});

test("every top-level command name in §6's tree resolves to a registered handler or subcommand table", () => {
  const expectedTopLevel = [
    "doctor", "init", "version", "update", "uninstall", "migrate", "completion",
    "config", "auth", "models", "context",
    "mcp", "tools", "skills", "agents", "plugins", "sessions",
    "parse", "ocr", "extract", "schema", "classify", "embed", "groundedness",
    "acp"
  ];
  for (const name of expectedTopLevel) {
    assert.ok(isRouterCommand(name), `expected "${name}" to be a registered router command`);
    const node = COMMANDS[name];
    assert.ok(
      typeof node.handler === "function" || (node.subcommands && Object.keys(node.subcommands).length > 0),
      `"${name}" should have a handler or a non-empty subcommand table`
    );
  }
});

test("namespaced commands' subcommands all resolve to handlers", async () => {
  const expectedSubcommands = {
    // `config`/`auth` are omitted here — Task 12.7/12.8 gave all of their
    // subcommands (config: list/get/set/path/edit, auth: status/test) real
    // implementations (src/cli/commands/config.mjs, auth.mjs), covered
    // separately by tests/m33-config-cli.test.mjs and
    // tests/m33-auth-cli.test.mjs, same as mcp/tools/skills/sessions above.
    // `models` is omitted here — Task 7.16 gave both of its subcommands
    // (list/info) real implementations (src/cli/commands/models.mjs),
    // covered separately by tests/m33-models-cli.test.mjs, same as
    // mcp/tools/skills/agents above.
    // "list"/"status"/"test"/"tools"/"show" excluded here — Task 12.4
    // replaced those stubs with real implementations
    // (src/cli/commands/mcp.mjs), covered separately by
    // tests/m33-cli-mcp.test.mjs, same as skills/install below.
    mcp: ["add", "remove"],
    // `tools`/`skills`/`agents` are omitted entirely below — Task 12.5 gave
    // every one of their subcommands (skills: list/show, install already
    // real from Task 7.9; tools/agents: list/show) a real implementation, so
    // none of them have a stub left to assert on here. Coverage for all four
    // namespaces' real list/show behavior lives in
    // tests/m33-introspection-commands.test.mjs (skills install stays in
    // tests/m33-skills-install.test.mjs). `plugins install` remains a stub —
    // out of scope (no CRUD for plugins per the plan) — so `plugins` is the
    // only one of the four still worth asserting on here.
    plugins: ["install"],
    // `sessions` is omitted here — Task 12.6 gave all four of its
    // subcommands (list/show/resume/export) real implementations
    // (src/cli/commands/sessions.mjs), covered separately by
    // tests/m33-sessions-cli.test.mjs, same as mcp/tools/skills/agents above.
    completion: ["bash", "zsh", "fish", "powershell"]
  };
  for (const [ns, subs] of Object.entries(expectedSubcommands)) {
    for (const sub of subs) {
      const io = captureStdio();
      try {
        const code = await dispatch([ns, sub]);
        assert.equal(code, 1, `${ns} ${sub} should return a non-zero (not-yet-implemented) exit code`);
      } finally {
        io.restore();
      }
    }
  }
});

// --- unknown top-level command falls through unchanged ---

test("unknown top-level command name is not claimed by the router", () => {
  assert.equal(isRouterCommand("frobnicate"), false);
  assert.equal(isRouterCommand("hello"), false);
  assert.equal(isRouterCommand(undefined), false);
});

test("chat/ask/tui are not claimed by the router (owned by parseCliArgs, unchanged)", () => {
  assert.equal(isRouterCommand("chat"), false);
  assert.equal(isRouterCommand("ask"), false);
  assert.equal(isRouterCommand("tui"), false);
});

test("dispatching an unregistered namespace subcommand prints usage and returns exit code 2", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["mcp", "bogus-subcommand"]);
    assert.equal(code, 2);
    assert.match(io.err.join(""), /Usage: upstage mcp <subcommand>/);
  } finally {
    io.restore();
  }
});

test("dispatching a bare namespace with no subcommand prints usage and returns exit code 2", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["config"]);
    assert.equal(code, 2);
    assert.match(io.err.join(""), /Usage: upstage config <subcommand>/);
  } finally {
    io.restore();
  }
});

// --- --help at any level prints that level's usage ---

test("--help at the root of a namespace prints that namespace's usage (exit 0, stdout)", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["mcp", "--help"]);
    assert.equal(code, 0);
    const text = io.out.join("");
    assert.match(text, /Usage: upstage mcp <subcommand>/);
    assert.match(text, /list/);
    assert.match(text, /show/);
    assert.equal(io.err.join(""), "");
  } finally {
    io.restore();
  }
});

test("-h at a namespaced leaf prints that leaf's usage (exit 0, stdout)", async () => {
  // "mcp show" now has a real implementation (Task 12.4) with its own usage
  // string wired into the router table, rather than the generic stub text.
  const io = captureStdio();
  try {
    const code = await dispatch(["mcp", "show", "-h"]);
    assert.equal(code, 0);
    assert.match(io.out.join(""), /Usage: upstage mcp show <name>/);
  } finally {
    io.restore();
  }
});

test("--help at a top-level leaf command prints usage (exit 0, stdout)", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["doctor", "--help"]);
    assert.equal(code, 0);
    assert.match(io.out.join(""), /Usage: upstage doctor \[options\]/);
  } finally {
    io.restore();
  }
});

test("--help passed to a leaf's real handler after positional args still shows usage", async () => {
  // Reaches runMcpShowCommand itself (not router-level interception, since
  // "myserver" precedes "--help"), which handles --help the same way
  // doctor/init/skills-install do.
  const io = captureStdio();
  try {
    const code = await dispatch(["mcp", "show", "myserver", "--help"]);
    assert.equal(code, 0);
    assert.match(io.out.join(""), /Usage: upstage mcp show <name>/);
  } finally {
    io.restore();
  }
});

// --- config -h/--help through the real router dispatch path ---
// Regression coverage for a reviewer-flagged gap (no existing test exercised
// --help through the real router dispatch path for config/auth): the router
// intercepts
// -h/--help before any leaf handler runs (see dispatch() above), using its
// own hardcoded `usage` string per leaf (COMMANDS.config.subcommands.get,
// etc.) — NOT src/cli/commands/config.mjs's own printGetUsage(), which is
// dead code for this path. `config get`'s router-level usage string used to
// claim it prints the "effective" (merged/cascade) settings value, which
// was stale once gatherConfigGet was fixed to read only the project
// settings file — this asserts the router's own text (not config.mjs's) is
// accurate.

test("dispatch(['config', 'get', '-h']) shows accurate router-level usage (not the stale 'effective' claim)", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["config", "get", "-h"]);
    assert.equal(code, 0);
    const text = io.out.join("");
    assert.doesNotMatch(text, /effective/);
    assert.match(text, /project settings/);
  } finally {
    io.restore();
  }
});

test("dispatch(['config', 'get', '--help']) shows the same accurate router-level usage", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["config", "get", "--help"]);
    assert.equal(code, 0);
    const text = io.out.join("");
    assert.doesNotMatch(text, /effective/);
    assert.match(text, /project settings/);
  } finally {
    io.restore();
  }
});

// --- regression: `-p`/`ask` behave identically to pre-3.2 ---

test("regression: parseCliArgs('-p', 'hello') is unaffected by the router (existing behavior preserved)", () => {
  assert.equal(isRouterCommand("-p"), false);
  const args = parseCliArgs(["-p", "hello"]);
  assert.equal(args.command, "chat");
  assert.equal(args.prompt, "hello");
});

test("regression: parseCliArgs('ask', 'hello') is unaffected by the router (existing behavior preserved)", () => {
  assert.equal(isRouterCommand("ask"), false);
  const args = parseCliArgs(["ask", "hello"]);
  assert.equal(args.command, "ask");
  assert.equal(args.prompt, "hello");
});

test("regression: a bare natural-language prompt is not claimed by the router", () => {
  const firstToken = "please fix bug".split(" ")[0];
  assert.equal(isRouterCommand(firstToken), false);
  const args = parseCliArgs(["please fix bug"]);
  assert.equal(args.command, "chat");
  assert.equal(args.prompt, "please fix bug");
});
