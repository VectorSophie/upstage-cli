// `upstage tools/skills/agents/plugins list/show` — Task 12.5 of the 3.2.0
// release plan.
//
// Two test strategies, matching the pattern this file's own commands use:
//   - `tools`/`skills`: exercised against BOTH an injected fixture (fast,
//     deterministic — no real subprocess/MCP connection) and, for `tools`,
//     one genuinely real end-to-end construction (a real stdio MCP server +
//     a real discovery subprocess) to prove `buildFullToolRegistry()`'s live
//     wiring actually works, not just the formatting layer on top of it.
//   - `agents`/`plugins`: exercised via an injected `loader` ONLY. Both
//     `AgentLoader`/`PluginLoader` search `os.homedir()` as one of their
//     SEARCH_DIRS/PLUGIN_ROOTS — going through a real `load(cwd)` in this
//     suite would pick up whatever real agents/plugins happen to exist on
//     the machine running the tests, which is exactly the kind of
//     environment leakage a deterministic test suite must avoid. Every
//     `gather*` function in agents.mjs/plugins.mjs accepts a pre-built
//     `loader` for precisely this reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createRegistry } from "../src/tools/create-registry.mjs";
import { createMcpTool } from "../src/tools/mcp/mcp-tool.mjs";
import { createDiscoveredTool } from "../src/tools/discovery/discovered-tool.mjs";
import { DEFAULT_POLICY } from "../src/config/defaults.mjs";

import {
  gatherToolsList, formatListHuman as formatToolsListHuman, formatListJson as formatToolsListJson,
  gatherToolsShow, formatShowHuman as formatToolsShowHuman, formatShowJson as formatToolsShowJson,
  runToolsListCommand, runToolsShowCommand
} from "../src/cli/commands/tools.mjs";

import {
  gatherSkillsList, formatListHuman as formatSkillsListHuman,
  gatherSkillsShow, formatShowHuman as formatSkillsShowHuman,
  runSkillsListCommand, runSkillsShowCommand
} from "../src/cli/commands/skills.mjs";

import {
  gatherAgentsList, formatListHuman as formatAgentsListHuman,
  gatherAgentsShow, formatShowHuman as formatAgentsShowHuman,
  runAgentsListCommand, runAgentsShowCommand
} from "../src/cli/commands/agents.mjs";

import {
  gatherPluginsList, formatListHuman as formatPluginsListHuman,
  gatherPluginsShow, formatShowHuman as formatPluginsShowHuman,
  runPluginsListCommand, runPluginsShowCommand
} from "../src/cli/commands/plugins.mjs";

import { SkillsLoader } from "../src/skills/loader.mjs";
import { AgentLoader } from "../src/agents/loader.mjs";
import { PluginLoader } from "../src/plugins/loader.mjs";
import { dispatch } from "../src/cli/router.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_STDIO = join(__dirname, "fixtures", "mock-mcp-server.mjs");

function withTempDir(run) {
  return mkdtemp(join(tmpdir(), "introspection-cli-")).then((dir) =>
    Promise.resolve()
      .then(() => run(dir))
      .finally(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  );
}

function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

function withEnv(vars, run) {
  const originals = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(run).finally(() => {
    for (const key of Object.keys(vars)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });
}

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  return {
    out, err,
    restore() { process.stdout.write = origOut; process.stderr.write = origErr; }
  };
}

// The actual current builtin tool count, derived from the real registry
// rather than hardcoded — CLAUDE.md currently documents 36, but per this
// task's own failure-mode note, that number is verified here, not assumed.
const BUILTIN_TOOL_COUNT = createRegistry({ ...DEFAULT_POLICY }).list().length;

// ═══════════════════════════════════════════════════════════════════════
// tools list/show
// ═══════════════════════════════════════════════════════════════════════

test("BUILTIN_TOOL_COUNT sanity: currently 36, matching CLAUDE.md's documented count", () => {
  assert.equal(BUILTIN_TOOL_COUNT, 36);
});

function buildFixtureRegistry() {
  const registry = createRegistry({ ...DEFAULT_POLICY });
  registry.register(createMcpTool({
    serverName: "fixture-server",
    toolName: "ping",
    description: "Replies pong",
    inputSchema: { type: "object", properties: {} },
    manager: { callTool: async () => ({ pong: true }) }
  }));
  registry.register(createDiscoveredTool(
    { name: "custom_tool", description: "A discovered fixture tool", risk: "low", actionClass: "read" },
    async () => ({ ok: true })
  ));
  return registry;
}

test("tools list --json (fixture registry): every builtin tool PLUS the fixture MCP and discovered tools, correctly tagged by source", async () => {
  const registry = buildFixtureRegistry();
  const rows = await gatherToolsList({ registry });

  const bySource = {};
  for (const r of rows) (bySource[r.source] ||= []).push(r);

  assert.equal(rows.length, BUILTIN_TOOL_COUNT + 2);
  assert.equal(bySource.builtin.length, BUILTIN_TOOL_COUNT);
  assert.equal(bySource.mcp.length, 1);
  assert.equal(bySource.mcp[0].name, "fixture-server__ping");
  assert.equal(bySource.discovered.length, 1);
  assert.equal(bySource.discovered[0].name, "discovered__custom_tool");

  // Raw source tags in the data are lowercase — uppercasing is display-only.
  assert.equal(bySource.mcp[0].source, "mcp");
  assert.equal(bySource.discovered[0].source, "discovered");

  const json = JSON.parse(formatToolsListJson(rows));
  assert.equal(json.length, BUILTIN_TOOL_COUNT + 2);
  assert.ok(json.some((t) => t.name === "fixture-server__ping" && t.source === "mcp"));
  assert.ok(json.some((t) => t.name === "discovered__custom_tool" && t.source === "discovered"));
});

test("tools list human output: grouped headers are uppercase (BUILTIN/MCP/DISCOVERED)", async () => {
  const registry = buildFixtureRegistry();
  const rows = await gatherToolsList({ registry });
  const text = formatToolsListHuman(rows);
  assert.match(text, /^BUILTIN$/m);
  assert.match(text, /^MCP$/m);
  assert.match(text, /^DISCOVERED$/m);
  assert.match(text, /fixture-server__ping/);
  assert.match(text, /discovered__custom_tool/);
});

test("tools show <name>: one builtin tool's full schema/description/source", async () => {
  const registry = buildFixtureRegistry();
  const outcome = await gatherToolsShow({ registry, name: "echo" });
  assert.ok(outcome.result, "expected a result, not an error");
  assert.equal(outcome.result.name, "echo");
  assert.equal(outcome.result.source, "builtin");
  assert.ok(outcome.result.inputSchema && typeof outcome.result.inputSchema === "object");

  const human = formatToolsShowHuman(outcome.result);
  assert.match(human, /name: echo/);
  assert.match(human, /source: BUILTIN/);

  const json = JSON.parse(formatToolsShowJson(outcome.result));
  assert.equal(json.source, "builtin");
});

test("tools show <mcp-tool-name>: fixture MCP tool shows source: mcp", async () => {
  const registry = buildFixtureRegistry();
  const outcome = await gatherToolsShow({ registry, name: "fixture-server__ping" });
  assert.ok(outcome.result);
  assert.equal(outcome.result.source, "mcp");
  assert.match(formatToolsShowHuman(outcome.result), /source: MCP/);
});

test("tools show <unknown>: usage error, code 2", async () => {
  const registry = buildFixtureRegistry();
  const outcome = await gatherToolsShow({ registry, name: "does-not-exist" });
  assert.equal(outcome.code, 2);
});

test("tools show with no name at all: usage error, code 2", async () => {
  const registry = buildFixtureRegistry();
  const outcome = await gatherToolsShow({ registry, name: undefined });
  assert.equal(outcome.code, 2);
});

test("runToolsListCommand/runToolsShowCommand: real exit codes against a bare temp cwd (no MCP servers, no discovery)", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runToolsListCommand([]), 0);
      assert.equal(await runToolsListCommand(["--json"]), 0);
      assert.equal(await runToolsShowCommand(["echo"]), 0);
      assert.equal(await runToolsShowCommand(["does-not-exist"]), 2);
      assert.equal(await runToolsShowCommand([]), 2);
    })
  )
);

test("runToolsListCommand --help / runToolsShowCommand --help print usage and exit 0", async () => {
  const io = captureStdio();
  try {
    assert.equal(await runToolsListCommand(["--help"]), 0);
    assert.equal(await runToolsShowCommand(["--help"]), 0);
    const text = io.out.join("");
    assert.match(text, /Usage: upstage tools list/);
    assert.match(text, /Usage: upstage tools show <name>/);
  } finally {
    io.restore();
  }
});

// ── tools list: REAL end-to-end construction (genuine stdio MCP server +
// genuine discovery subprocess), proving buildFullToolRegistry()'s actual
// wiring works, not just the fixture-registry formatting layer above ──────

test("tools list (real construction): builtin + a genuinely connected MCP server + a genuinely invoked discovery command", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: { "fixture-mcp": { command: process.execPath, args: [MOCK_STDIO] } }
    }));

    const discoveryScript = join(dir, "discovery.mjs");
    await writeFile(
      discoveryScript,
      [
        'const mode = process.argv[2];',
        'if (mode === "discover") {',
        '  process.stdout.write(JSON.stringify([',
        '    { name: "custom_tool", description: "real discovered fixture tool", risk: "low", actionClass: "read" }',
        '  ]));',
        '  process.exit(0);',
        '}',
        'process.stdout.write("{}");'
      ].join("\n"),
      "utf8"
    );

    await withEnv(
      {
        // Bare `node`, not `process.execPath`: `runSandboxedCommand` (src/sandbox/exec.mjs)
        // splits the command string on whitespace and checks the binary against
        // a fixed allowlist — an absolute interpreter path (e.g. Windows's default
        // `C:\Program Files\nodejs\node.exe`) both contains spaces that break the
        // split AND wouldn't match the allowlist anyway. `node` is on the allowlist
        // and resolves via PATH, matching the existing precedent in
        // tests/m9-improvements.test.mjs's discovery-wiring test.
        UPSTAGE_DISCOVERY_COMMAND: `node ${discoveryScript} discover`,
        UPSTAGE_DISCOVERY_INVOKE_COMMAND: `node ${discoveryScript} invoke`
      },
      async () => {
        const rows = await gatherToolsList({ cwd: dir, settings: {} });
        const bySource = {};
        for (const r of rows) (bySource[r.source] ||= []).push(r);

        assert.equal(bySource.builtin?.length, BUILTIN_TOOL_COUNT);
        assert.ok(bySource.mcp?.some((t) => t.name === "fixture-mcp__add"));
        assert.ok(bySource.mcp?.some((t) => t.name === "fixture-mcp__echo"));
        assert.ok(bySource.discovered?.some((t) => t.name === "discovered__custom_tool"));
      }
    );
  })
);

// ═══════════════════════════════════════════════════════════════════════
// skills list/show
// ═══════════════════════════════════════════════════════════════════════

test("skills list (real cwd): a project-local fixture skill appears alongside the always-present bundled pack", () =>
  withTempDir(async (dir) => {
    const skillDir = join(dir, ".upstage", "skills", "fixture-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A fixture skill for testing\n---\nFixture body.",
      "utf8"
    );

    const rows = await gatherSkillsList({ cwd: dir });
    assert.ok(rows.length > 1, "expected the bundled pack plus the fixture skill");
    const fixture = rows.find((s) => s.name === "fixture-skill");
    assert.ok(fixture, "fixture-skill not found in skills list");
    assert.equal(fixture.description, "A fixture skill for testing");

    const text = formatSkillsListHuman(rows);
    assert.match(text, /fixture-skill — A fixture skill for testing/);
  })
);

test("skills show <name>: full detail including prompt body", () =>
  withTempDir(async (dir) => {
    const skillDir = join(dir, ".upstage", "skills", "fixture-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A fixture skill for testing\n---\nFixture body text.",
      "utf8"
    );

    const outcome = await gatherSkillsShow({ cwd: dir, name: "fixture-skill" });
    assert.ok(outcome.result);
    assert.equal(outcome.result.prompt, "Fixture body text.");

    const human = formatSkillsShowHuman(outcome.result);
    assert.match(human, /name: fixture-skill/);
    assert.match(human, /Fixture body text\./);
  })
);

test("skills show <unknown>: usage error, code 2", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherSkillsShow({ cwd: dir, name: "definitely-does-not-exist-skill" });
    assert.equal(outcome.code, 2);
  })
);

test("skills show with no name: usage error, code 2", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherSkillsShow({ cwd: dir, name: undefined });
    assert.equal(outcome.code, 2);
  })
);

test("runSkillsListCommand/runSkillsShowCommand: real exit codes", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runSkillsListCommand([]), 0);
      assert.equal(await runSkillsListCommand(["--json"]), 0);
      assert.equal(await runSkillsShowCommand(["korean-pii-guard"]), 0); // bundled skill
      assert.equal(await runSkillsShowCommand(["does-not-exist"]), 2);
      assert.equal(await runSkillsShowCommand([]), 2);
    })
  )
);

// Injected-loader variant, for isolation from the always-present bundled pack.
test("gatherSkillsList/gatherSkillsShow accept a pre-loaded loader (fixture-only, no bundled pack noise)", async () => {
  const loader = new SkillsLoader();
  loader.skills.set("iso-skill", { name: "iso-skill", description: "isolated", aliases: ["iso"], license: null, prompt: "body" });

  const rows = await gatherSkillsList({ loader });
  assert.deepEqual(rows, [{ name: "iso-skill", description: "isolated", aliases: ["iso"], license: null }]);

  const outcome = await gatherSkillsShow({ loader, name: "iso-skill" });
  assert.equal(outcome.result.prompt, "body");
});

// ═══════════════════════════════════════════════════════════════════════
// agents list/show — injected AgentLoader only (see file header: real
// load(cwd) also searches os.homedir(), which would leak real machine state
// into this suite)
// ═══════════════════════════════════════════════════════════════════════

function fixtureAgentLoader() {
  const loader = new AgentLoader();
  loader.agents.set("reviewer", {
    name: "reviewer",
    description: "Reviews code for correctness",
    model: "solar-pro4",
    tools: ["read_file", "grep"],
    hooks: {},
    prompt: "You are a careful code reviewer."
  });
  loader.agents.set("planner", {
    name: "planner",
    description: "Plans multi-step work",
    model: null,
    tools: [],
    hooks: {},
    prompt: "You plan things."
  });
  return loader;
}

test("agents list: returns every loaded agent def with name/description/model/tools", async () => {
  const loader = fixtureAgentLoader();
  const rows = await gatherAgentsList({ loader });
  assert.equal(rows.length, 2);
  const reviewer = rows.find((a) => a.name === "reviewer");
  assert.deepEqual(reviewer, {
    name: "reviewer", description: "Reviews code for correctness", model: "solar-pro4", tools: ["read_file", "grep"]
  });

  const text = formatAgentsListHuman(rows);
  assert.match(text, /reviewer \(solar-pro4\) — Reviews code for correctness/);
  assert.match(text, /planner — Plans multi-step work/); // no model shown when null
});

test("agents show <name>: full agent def including prompt", async () => {
  const loader = fixtureAgentLoader();
  const outcome = await gatherAgentsShow({ loader, name: "reviewer" });
  assert.ok(outcome.result);
  assert.equal(outcome.result.prompt, "You are a careful code reviewer.");
  const human = formatAgentsShowHuman(outcome.result);
  assert.match(human, /name: reviewer/);
  assert.match(human, /tools: read_file, grep/);
  assert.match(human, /You are a careful code reviewer\./);
});

test("agents show <unknown>: usage error, code 2", async () => {
  const loader = fixtureAgentLoader();
  const outcome = await gatherAgentsShow({ loader, name: "does-not-exist" });
  assert.equal(outcome.code, 2);
});

test("agents show with no name: usage error, code 2", async () => {
  const loader = fixtureAgentLoader();
  const outcome = await gatherAgentsShow({ loader, name: undefined });
  assert.equal(outcome.code, 2);
});

test("runAgentsListCommand/runAgentsShowCommand: real exit codes against an empty (no-fixture) temp cwd", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runAgentsListCommand([]), 0);
      assert.equal(await runAgentsListCommand(["--json"]), 0);
      assert.equal(await runAgentsShowCommand([]), 2);
      assert.equal(await runAgentsShowCommand(["does-not-exist"]), 2);
    })
  )
);

test("runAgentsListCommand/runAgentsShowCommand --help print usage and exit 0", async () => {
  const io = captureStdio();
  try {
    assert.equal(await runAgentsListCommand(["--help"]), 0);
    assert.equal(await runAgentsShowCommand(["--help"]), 0);
    const text = io.out.join("");
    assert.match(text, /Usage: upstage agents list/);
    assert.match(text, /Usage: upstage agents show <name>/);
  } finally {
    io.restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// plugins list/show — injected PluginLoader only (real load(cwd) also
// searches os.homedir(), same leakage concern as agents above)
// ═══════════════════════════════════════════════════════════════════════

function fixturePluginLoader() {
  const loader = new PluginLoader();
  loader.plugins.push({ name: "my-plugin", version: "1.2.3", dir: "/fake/plugins/my-plugin" });
  loader.plugins.push({ name: "other-plugin", version: "0.0.1", dir: "/fake/plugins/other-plugin" });
  loader.commands.push({ name: "/mycmd", description: "Does a thing", body: "...", plugin: "my-plugin" });
  loader.commands.push({ name: "/othercmd", description: "", body: "...", plugin: "other-plugin" });
  return loader;
}

test("plugins list: returns every loaded plugin's {name, version} (PluginLoader.list()'s own shape)", async () => {
  const loader = fixturePluginLoader();
  const rows = await gatherPluginsList({ loader });
  assert.deepEqual(rows, [
    { name: "my-plugin", version: "1.2.3" },
    { name: "other-plugin", version: "0.0.1" }
  ]);
  const text = formatPluginsListHuman(rows);
  assert.match(text, /my-plugin \(1\.2\.3\)/);
});

test("plugins show <name>: version, dir, and only ITS OWN commands (ownership filtered correctly)", async () => {
  const loader = fixturePluginLoader();
  const outcome = await gatherPluginsShow({ loader, name: "my-plugin" });
  assert.ok(outcome.result);
  assert.equal(outcome.result.version, "1.2.3");
  assert.equal(outcome.result.dir, "/fake/plugins/my-plugin");
  assert.deepEqual(outcome.result.commands, [{ name: "/mycmd", description: "Does a thing" }]);
  // other-plugin's command must NOT leak into my-plugin's show output.
  assert.ok(!outcome.result.commands.some((c) => c.name === "/othercmd"));

  const human = formatPluginsShowHuman(outcome.result);
  assert.match(human, /name: my-plugin/);
  assert.match(human, /\/mycmd — Does a thing/);
});

test("plugins show <unknown>: usage error, code 2", async () => {
  const loader = fixturePluginLoader();
  const outcome = await gatherPluginsShow({ loader, name: "does-not-exist" });
  assert.equal(outcome.code, 2);
});

test("plugins show with no name: usage error, code 2", async () => {
  const loader = fixturePluginLoader();
  const outcome = await gatherPluginsShow({ loader, name: undefined });
  assert.equal(outcome.code, 2);
});

test("runPluginsListCommand/runPluginsShowCommand: real exit codes against an empty temp cwd", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runPluginsListCommand([]), 0);
      assert.equal(await runPluginsListCommand(["--json"]), 0);
      assert.equal(await runPluginsShowCommand([]), 2);
      assert.equal(await runPluginsShowCommand(["does-not-exist"]), 2);
    })
  )
);

test("runPluginsListCommand/runPluginsShowCommand --help print usage and exit 0", async () => {
  const io = captureStdio();
  try {
    assert.equal(await runPluginsListCommand(["--help"]), 0);
    assert.equal(await runPluginsShowCommand(["--help"]), 0);
    const text = io.out.join("");
    assert.match(text, /Usage: upstage plugins list/);
    assert.match(text, /Usage: upstage plugins show <name>/);
  } finally {
    io.restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// router wiring: dispatch() reaches the real handlers, not stubs
// ═══════════════════════════════════════════════════════════════════════

test("router: dispatch reaches the real tools/skills/agents/plugins list/show handlers, not the generic stub", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      for (const argv of [
        ["tools", "list"], ["tools", "show", "echo"],
        ["skills", "list"], ["skills", "show", "korean-pii-guard"],
        ["agents", "list"], ["plugins", "list"]
      ]) {
        const io = captureStdio();
        try {
          const code = await dispatch(argv);
          assert.equal(code, 0, `dispatch(${JSON.stringify(argv)}) should exit 0, not fall through to a stub`);
          assert.doesNotMatch(io.err.join(""), /not yet implemented/);
        } finally {
          io.restore();
        }
      }
    })
  )
);

test("router: agents/plugins show with no name still returns a real usage error (code 2), not the stub's code 1", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      for (const argv of [["agents", "show"], ["plugins", "show"], ["tools", "show"], ["skills", "show"]]) {
        const io = captureStdio();
        try {
          const code = await dispatch(argv);
          assert.equal(code, 2, `dispatch(${JSON.stringify(argv)}) should be a usage error (2)`);
        } finally {
          io.restore();
        }
      }
    })
  )
);
