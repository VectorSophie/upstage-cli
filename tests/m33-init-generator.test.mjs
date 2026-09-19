import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateUpstageMd,
  mergeGeneratedBlock,
  buildGeneratedContent,
  aggregateDirectories,
  mostDependedUponModules,
  MARKER_START,
  MARKER_END
} from "../src/agent/init-generator.mjs";
import { runInitCommand, formatDryRunOutput, formatWriteSummary } from "../src/cli/commands/init.mjs";
import { executeCommand } from "../src/ui/commands.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-init-gen-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

// Captures real stdout SYNCHRONOUSLY only — i.e. `run` must not cross a real
// `await`. node --test uses process.stdout as its own result-reporting
// channel; overriding process.stdout.write across a real async boundary was
// tried here (to assert on runInitCommand's actual printed output for the
// non-help paths) and empirically caused 8 *unrelated* tests elsewhere in
// this same file to silently vanish from the report entirely (not fail, not
// "cancelled" — just never reported), almost certainly by swallowing the
// test runner's own in-flight protocol writes during the intercepted
// window. tests/m33-doctor.test.mjs's own comment already flags this exact
// risk for runDoctorCommand and deliberately avoids it the same way; this
// file initially didn't heed that warning closely enough and hit it in
// practice. The fix: runInitCommand's stdout-writing is now a thin wrapper
// around pure formatters (formatDryRunOutput/formatWriteSummary, exported
// from src/cli/commands/init.mjs) — tests assert on THOSE directly, fed by
// a real generateUpstageMd() result, and only use this synchronous-only
// capture for the --help path (which never awaits real I/O).
function captureStdioSync(run) {
  const outChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { outChunks.push(String(chunk)); return true; };
  try {
    run();
  } finally {
    process.stdout.write = origOut;
  }
  return outChunks.join("");
}

function writeFixturePackageJson(dir, overrides = {}) {
  const pkg = {
    name: "fixture-project",
    version: "0.1.0",
    description: "a fixture project for init-generator tests",
    type: "module",
    engines: { node: ">=18" },
    bin: { fixturebin: "src/index.mjs" },
    scripts: {
      dev: "node src/index.mjs",
      test: "node --test tests/",
      lint: "eslint src/",
      typecheck: "tsc --noEmit",
      ...overrides.scripts
    },
    dependencies: { react: "^19.0.0" },
    devDependencies: { eslint: "^9.0.0" },
    ...overrides
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

function writeFixtureSource(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.mjs"),
    [
      "export function runServer() {",
      "  return 'running';",
      "}",
      "",
      "export class AppController {}",
      ""
    ].join("\n")
  );
}

// ── mergeGeneratedBlock: pure, no I/O ──────────────────────────────────────

test("mergeGeneratedBlock: no existing content creates just the wrapped block", () => {
  const { content, action } = mergeGeneratedBlock(null, "hello world");
  assert.equal(action, "created");
  assert.match(content, new RegExp(`^${MARKER_START}\\nhello world\\n${MARKER_END}`));
});

test("mergeGeneratedBlock: existing content with valid markers replaces only the interior", () => {
  const existing = `# My Project\n\nSome hand-written notes.\n\n${MARKER_START}\nold generated stuff\n${MARKER_END}\n\nMore hand-written notes after.\n`;
  const { content, action } = mergeGeneratedBlock(existing, "new generated stuff");
  assert.equal(action, "updated");
  assert.match(content, /# My Project/);
  assert.match(content, /Some hand-written notes\./);
  assert.match(content, /More hand-written notes after\./);
  assert.match(content, /new generated stuff/);
  assert.doesNotMatch(content, /old generated stuff/);
});

test("mergeGeneratedBlock: existing content with no markers appends a new block, preserving original content verbatim", () => {
  const existing = "# Hand-written UPSTAGE.md\n\nNo markers here at all.\n";
  const { content, action } = mergeGeneratedBlock(existing, "fresh block");
  assert.equal(action, "appended");
  assert.ok(content.startsWith(existing), "original content must appear byte-for-byte at the start");
  assert.match(content, new RegExp(`${MARKER_START}\\nfresh block\\n${MARKER_END}`));
});

test("mergeGeneratedBlock: malformed marker pair (end before start) is treated as no valid markers and appended safely", () => {
  const existing = `${MARKER_END}\nsome text\n${MARKER_START}\n`;
  const { content, action } = mergeGeneratedBlock(existing, "safe block");
  assert.equal(action, "appended");
  assert.ok(content.startsWith(existing));
  assert.match(content, /safe block/);
});

test("mergeGeneratedBlock: only a start marker (no end) is treated as no valid markers and appended safely", () => {
  const existing = `# Doc\n\n${MARKER_START}\nunterminated\n`;
  const { content, action } = mergeGeneratedBlock(existing, "safe block 2");
  assert.equal(action, "appended");
  assert.ok(content.startsWith(existing));
});

// ── buildGeneratedContent: real analysis of a fixture project ─────────────

test("buildGeneratedContent produces all required sections from real repo analysis", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);
    const block = await buildGeneratedContent(dir);

    for (const heading of [
      "## Architecture",
      "## Entry Points",
      "## Important Directories",
      "## Build",
      "## Test",
      "## Lint",
      "## Typecheck",
      "## Runtime & Frameworks"
    ]) {
      assert.ok(block.includes(heading), `expected block to contain "${heading}"`);
    }

    // Real facts, not templated filler.
    assert.match(block, /fixture-project/);
    assert.match(block, /fixturebin/);
    assert.match(block, /eslint src\//); // detected lint command
    assert.match(block, /tsc --noEmit/); // detected typecheck command
    assert.match(block, /node --test tests\//); // detected test command
    assert.match(block, /react/); // dependency
  });
});

test("buildGeneratedContent handles a bare directory with no package.json without throwing", () => {
  return withTempDir(async (dir) => {
    const block = await buildGeneratedContent(dir);
    assert.match(block, /## Architecture/);
    assert.match(block, /No build script detected/);
    assert.match(block, /No test script detected/);
  });
});

// ── generateUpstageMd: full orchestration + disk I/O ───────────────────────

test("first run creates UPSTAGE.md with markers", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const result = await generateUpstageMd({ cwd: dir });
    assert.equal(result.action, "created");
    assert.equal(result.written, true);

    const path = join(dir, "UPSTAGE.md");
    assert.ok(existsSync(path));
    const onDisk = readFileSync(path, "utf8");
    assert.match(onDisk, new RegExp(MARKER_START));
    assert.match(onDisk, new RegExp(MARKER_END));
    assert.match(onDisk, /## Architecture/);
  });
});

test("second run preserves user-written content outside the markers and only replaces what's inside", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    // First run creates the file.
    await generateUpstageMd({ cwd: dir });

    // Simulate a human editing the file: add hand-written prose before and
    // after the generated block.
    const path = join(dir, "UPSTAGE.md");
    const afterFirstRun = readFileSync(path, "utf8");
    const handWritten = `# Fixture Project\n\nThis is a hand-written note a developer added.\n\n${afterFirstRun}\n## Developer Notes\n\nDo not remove this section.\n`;
    writeFileSync(path, handWritten);

    // Change a fact on disk so the second run's generated content actually
    // differs from the first (proves regeneration really happened, not a
    // no-op).
    writeFixturePackageJson(dir, { scripts: { lint: "eslint --fix src/" } });

    const result = await generateUpstageMd({ cwd: dir });
    assert.equal(result.action, "updated");

    const onDisk = readFileSync(path, "utf8");
    assert.match(onDisk, /This is a hand-written note a developer added\./);
    assert.match(onDisk, /## Developer Notes/);
    assert.match(onDisk, /Do not remove this section\./);
    // Regenerated content picked up the new fact.
    assert.match(onDisk, /eslint --fix src\//);
    // Exactly one marker pair — no duplication.
    assert.equal(onDisk.split(MARKER_START).length - 1, 1);
    assert.equal(onDisk.split(MARKER_END).length - 1, 1);
  });
});

test("a hand-written UPSTAGE.md with no markers yet gets a block appended, not overwritten", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const path = join(dir, "UPSTAGE.md");
    const handWritten = "# Fixture Project\n\nPre-existing hand-written architecture notes.\n";
    writeFileSync(path, handWritten);

    const result = await generateUpstageMd({ cwd: dir });
    assert.equal(result.action, "appended");

    const onDisk = readFileSync(path, "utf8");
    assert.ok(onDisk.startsWith(handWritten), "original hand-written content must survive byte-for-byte at the start");
    assert.match(onDisk, new RegExp(MARKER_START));
    assert.match(onDisk, /## Architecture/);
  });
});

test("--dry-run writes nothing to disk on a directory with no prior UPSTAGE.md", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const result = await generateUpstageMd({ cwd: dir, dryRun: true });
    assert.equal(result.written, false);
    assert.equal(result.action, "dry-run");
    assert.match(result.block, /## Architecture/);
    assert.equal(existsSync(join(dir, "UPSTAGE.md")), false, "dry-run must not create UPSTAGE.md");
  });
});

test("--dry-run leaves an existing UPSTAGE.md byte-for-byte untouched", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    await generateUpstageMd({ cwd: dir }); // real write first
    const path = join(dir, "UPSTAGE.md");
    const before = readFileSync(path, "utf8");

    // Change a fact so a real run would produce different content...
    writeFixturePackageJson(dir, { scripts: { lint: "eslint --fix src/" } });

    const result = await generateUpstageMd({ cwd: dir, dryRun: true });
    assert.equal(result.written, false);
    assert.match(result.block, /eslint --fix src\//); // computed the new content...

    const after = readFileSync(path, "utf8");
    assert.equal(after, before, "...but never wrote it to disk");
  });
});

// ── --refresh: documented no-op alias (see init-generator.mjs's doc-comment) ──

test("--refresh produces the same result as the default (no staleness heuristic; both always regenerate)", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);
    await generateUpstageMd({ cwd: dir });

    const withoutRefresh = await generateUpstageMd({ cwd: dir, refresh: false });
    const withRefresh = await generateUpstageMd({ cwd: dir, refresh: true });

    assert.equal(withoutRefresh.action, withRefresh.action);
    assert.equal(withoutRefresh.content, withRefresh.content);
  });
});

// ── aggregateDirectories / mostDependedUponModules: direct unit coverage ──
// (previously only exercised indirectly through buildGeneratedContent)

test("aggregateDirectories groups files and symbols by directory, sorted by file count descending", () => {
  const index = {
    fileSignatures: {
      "src/a/one.mjs": {},
      "src/a/two.mjs": {},
      "src/b/three.mjs": {}
    },
    symbols: [
      { name: "fnOne", file: "src/a/one.mjs" },
      { name: "fnTwo", file: "src/a/two.mjs" },
      { name: "fnTwo", file: "src/a/two.mjs" }, // duplicate name — sample should dedupe
      { name: "fnThree", file: "src/b/three.mjs" }
    ]
  };
  const rows = aggregateDirectories(index);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dir, "src/a");
  assert.equal(rows[0].fileCount, 2);
  assert.equal(rows[0].symbolCount, 3);
  assert.deepEqual(rows[0].sample.sort(), ["fnOne", "fnTwo"]); // deduped
  assert.equal(rows[1].dir, "src/b");
  assert.equal(rows[1].fileCount, 1);
});

test("aggregateDirectories respects the limit option", () => {
  const fileSignatures = {};
  for (let i = 0; i < 5; i += 1) fileSignatures[`src/dir${i}/file.mjs`] = {};
  const rows = aggregateDirectories({ fileSignatures, symbols: [] }, { limit: 2 });
  assert.equal(rows.length, 2);
});

test("mostDependedUponModules ranks files by internal incoming-import count, descending", () => {
  const index = {
    importsByFile: {
      "src/a.mjs": ["src/core.mjs"],
      "src/b.mjs": ["src/core.mjs", "src/util.mjs"],
      "src/c.mjs": ["src/core.mjs"]
    }
  };
  const top = mostDependedUponModules(index);
  assert.equal(top[0].file, "src/core.mjs");
  assert.equal(top[0].count, 3);
  assert.equal(top[1].file, "src/util.mjs");
  assert.equal(top[1].count, 1);
});

test("mostDependedUponModules returns an empty array when there are no import edges", () => {
  const top = mostDependedUponModules({ importsByFile: {} });
  assert.deepEqual(top, []);
});

// ── runInitCommand (src/cli/commands/init.mjs): CLI adapter coverage ──────
// Mirrors tests/m33-doctor.test.mjs's coverage of runDoctorCommand's exit
// codes/output shape — this file previously had zero coverage of the CLI
// adapter itself (only the shared generator was tested).

test("runInitCommand -h/--help prints usage and exits 0 without running checks (fully synchronous — safe to capture)", async () => {
  // Same pattern as tests/m33-doctor.test.mjs's equivalent --help test:
  // runInitCommand's --help branch never awaits real I/O before resolving,
  // so this synchronous capture window is safe (see captureStdioSync above).
  let code;
  const out = captureStdioSync(() => {
    runInitCommand(["--help"]).then((c) => { code = c; });
  });
  assert.match(out, /Usage: upstage init/);
  // The .then callback above runs on a microtask; give it a tick.
  await Promise.resolve();
  assert.equal(code, 0);
});

test("runInitCommand (no flags) creates UPSTAGE.md and exits 0", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const code = await runInitCommand([]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, "UPSTAGE.md")), true);
  }));
});

test("runInitCommand --dry-run exits 0 and writes nothing to disk", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const code = await runInitCommand(["--dry-run"]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, "UPSTAGE.md")), false, "--dry-run must not write UPSTAGE.md");
  }));
});

test("runInitCommand --refresh behaves the same as the default (documented no-op alias)", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    assert.equal(await runInitCommand([]), 0);
    assert.equal(await runInitCommand(["--refresh"]), 0);
    assert.equal(existsSync(join(dir, "UPSTAGE.md")), true);
  }));
});

// 3.3.0 Thread C, Task C.5
test("runInitCommand --with-browser-mcp also writes a chrome-devtools-mcp entry to .mcp.json", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const code = await runInitCommand(["--with-browser-mcp"]);
    assert.equal(code, 0);
    const mcpJson = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.ok(mcpJson.mcpServers["chrome-devtools"]);
  }));
});

test("runInitCommand without --with-browser-mcp never touches .mcp.json", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const code = await runInitCommand([]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, ".mcp.json")), false);
  }));
});

// formatDryRunOutput/formatWriteSummary: the pure formatters runInitCommand
// wraps around process.stdout.write — this is what actually verifies
// runInitCommand's OUTPUT CONTENT (not just its exit code/side effects),
// fed by a real generateUpstageMd() result, with no stdout interception
// needed at all (see captureStdioSync's comment above for why that matters).

test("formatDryRunOutput includes the path, a dry-run label, and the real generated content preview", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);
    const result = await generateUpstageMd({ cwd: dir, dryRun: true });

    const out = formatDryRunOutput(result);
    assert.match(out, /dry-run/i);
    assert.match(out, new RegExp(result.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(out, /## Architecture/);
    assert.match(out, /fixture-project/);
  });
});

test("formatWriteSummary reports the correct action label for created vs. updated", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const created = await generateUpstageMd({ cwd: dir });
    assert.match(formatWriteSummary(created), /Created UPSTAGE\.md/);

    const updated = await generateUpstageMd({ cwd: dir });
    assert.match(formatWriteSummary(updated), /Updated the generated block/);
  });
});

// ── /init TUI slash command (src/ui/commands.mjs): adapter coverage ───────
//
// Regression coverage for the bug flagged in code review: App.mjs:376 drops
// any `result.response` that starts with "__" from the visible chat (that's
// the exact mechanism `__clear__`/`__new_session__` rely on to stay
// invisible — they all short-circuit via a dedicated boolean flag BEFORE
// that check). The original /init --dry-run implementation built its
// response as `` `__dry_run__ (...)\n\n${block}` `` with no such flag, so it
// was silently swallowed by that same suppression and never reached the
// user. These tests assert the dry-run response does NOT start with "__"
// (which would have caught the bug directly) and DOES contain the preview.

function makeInitState(cwd) {
  return {
    messages: [],
    _session: { id: "t", createdAt: Date.now(), history: [], toolResults: [], workspace: { cwd } }
  };
}

test("/init creates UPSTAGE.md and returns a plain (non-sentinel) chat response", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const result = await executeCommand("/init", makeInitState(dir));
    assert.ok(!result.response.startsWith("__"), `response must not start with "__" (App.mjs would swallow it): ${result.response.slice(0, 40)}`);
    assert.match(result.response, /UPSTAGE\.md/);
    assert.equal(existsSync(join(dir, "UPSTAGE.md")), true);
  });
});

test("/init --dry-run returns the generated content preview as a plain response (not swallowed by App.mjs's \"__\" sentinel suppression) and writes nothing to disk", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    const result = await executeCommand("/init --dry-run", makeInitState(dir));
    // This is the exact assertion that catches the reported bug: App.mjs
    // only appends result.response to the chat when it does NOT start with
    // "__". The original implementation's response started with
    // "__dry_run__" and was therefore invisible in the TUI.
    assert.ok(!result.response.startsWith("__"), `dry-run response must not start with "__" (App.mjs would swallow it): ${result.response.slice(0, 40)}`);
    assert.match(result.response, /## Architecture/, "dry-run response should contain the actual generated content preview");
    assert.equal(existsSync(join(dir, "UPSTAGE.md")), false, "--dry-run must not write UPSTAGE.md");
  });
});

test("/init --refresh behaves the same as the default (documented no-op alias)", () => {
  return withTempDir(async (dir) => {
    writeFixturePackageJson(dir);
    writeFixtureSource(dir);

    await executeCommand("/init", makeInitState(dir));
    const result = await executeCommand("/init --refresh", makeInitState(dir));
    assert.ok(!result.response.startsWith("__"));
    assert.match(result.response, /UPSTAGE\.md/);
  });
});
