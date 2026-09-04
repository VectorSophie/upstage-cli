import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateUpstageMd,
  mergeGeneratedBlock,
  buildGeneratedContent,
  MARKER_START,
  MARKER_END
} from "../src/agent/init-generator.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-init-gen-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
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
