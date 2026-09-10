// `upstage skills install` — Task 7.9 of the 3.2.0 release plan.
//
// Covers: file lands at the right path(s) with correct frontmatter (parsed,
// not just grep'd), idempotent re-runs (no duplication, no error, "unchanged"
// status), the --target narrowing behavior, and the user-content-protection
// warning path (hand-edited/differing destination gets a stderr warning
// before being overwritten — never silently clobbered without one).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runSkillsInstallCommand,
  readSourceContent,
  installOne,
  formatHuman
} from "../src/cli/commands/skills-install.mjs";
import { dispatch } from "../src/cli/router.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-skills-install-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

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

// Minimal YAML-frontmatter parser mirroring src/skills/loader.mjs's own
// parseFrontmatter (kept independent/inline here rather than importing that
// unexported helper, so this test exercises the ON-DISK file's actual shape
// the way any consumer — SkillsLoader or another agent harness — would).
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, "installed SKILL.md must have a valid --- frontmatter block");
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

const ALL_SEVEN_COMMANDS = ["parse", "ocr", "extract", "schema", "classify", "embed", "groundedness"];

// ── readSourceContent / the bundled skill file itself ─────────────────────

test("readSourceContent reads the real skills/upstage-utilities/SKILL.md", () => {
  const content = readSourceContent();
  const { meta } = parseFrontmatter(content);
  assert.equal(meta.name, "upstage-utilities");
  assert.equal(meta["allowed-tools"], "Bash(upstage *)");
});

test("the bundled skill documents all 7 Task 7.8 commands", () => {
  const content = readSourceContent();
  for (const cmd of ALL_SEVEN_COMMANDS) {
    assert.match(content, new RegExp(`upstage ${cmd}\\b`), `expected the skill body to document "upstage ${cmd}"`);
  }
});

// ── installOne: pure, no cwd dependency ────────────────────────────────────

test("installOne creates the file (with parent dirs) when nothing exists yet", () => {
  return withTempDir((dir) => {
    const dest = join(dir, "nested", "skills", "upstage-utilities", "SKILL.md");
    const source = readSourceContent();
    const result = installOne(dest, source);
    assert.equal(result.status, "created");
    assert.equal(existsSync(dest), true);
    assert.equal(readFileSync(dest, "utf8"), source);
  });
});

test("installOne on a second run with unchanged content reports \"unchanged\", no duplication/error", () => {
  return withTempDir((dir) => {
    const dest = join(dir, "SKILL.md");
    const source = readSourceContent();
    const first = installOne(dest, source);
    assert.equal(first.status, "created");
    const second = installOne(dest, source);
    assert.equal(second.status, "unchanged");
    assert.equal(readFileSync(dest, "utf8"), source);
  });
});

test("installOne on a differing existing file warns to stderr and reports \"overwritten\"", () => {
  return withTempDir((dir) => {
    const dest = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, "---\nname: upstage-utilities\n---\n\nhand-edited content, not the canonical body\n");
    const source = readSourceContent();

    const io = captureStdio();
    let result;
    try {
      result = installOne(dest, source);
    } finally {
      io.restore();
    }

    assert.equal(result.status, "overwritten");
    assert.match(io.err.join(""), /already exists with different content/);
    assert.equal(readFileSync(dest, "utf8"), source, "must still converge to the canonical content after warning");
  });
});

// ── formatHuman ─────────────────────────────────────────────────────────────

test("formatHuman renders one status line per result", () => {
  const out = formatHuman([
    { path: "/a/SKILL.md", status: "created" },
    { path: "/b/SKILL.md", status: "unchanged" }
  ]);
  assert.match(out, /created: \/a\/SKILL\.md/);
  assert.match(out, /unchanged: \/b\/SKILL\.md/);
});

// ── runSkillsInstallCommand: CLI adapter, default destinations ────────────

test("default install (no --target) writes to BOTH .upstage/skills/ and .claude/skills/, correct frontmatter", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const code = await runSkillsInstallCommand([]);
    assert.equal(code, 0);

    const upstagePath = join(dir, ".upstage", "skills", "upstage-utilities", "SKILL.md");
    const claudePath = join(dir, ".claude", "skills", "upstage-utilities", "SKILL.md");
    assert.equal(existsSync(upstagePath), true);
    assert.equal(existsSync(claudePath), true);

    for (const path of [upstagePath, claudePath]) {
      const content = readFileSync(path, "utf8");
      const { meta, body } = parseFrontmatter(content);
      assert.equal(meta.name, "upstage-utilities");
      assert.equal(meta["allowed-tools"], "Bash(upstage *)");
      for (const cmd of ALL_SEVEN_COMMANDS) {
        assert.match(body, new RegExp(`upstage ${cmd}\\b`));
      }
    }
  }));
});

test("re-running the default install is idempotent: same files, no duplication, no error, exit 0 both times", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const first = await runSkillsInstallCommand([]);
    const upstagePath = join(dir, ".upstage", "skills", "upstage-utilities", "SKILL.md");
    const claudePath = join(dir, ".claude", "skills", "upstage-utilities", "SKILL.md");
    const afterFirst = {
      upstage: readFileSync(upstagePath, "utf8"),
      claude: readFileSync(claudePath, "utf8")
    };

    const io = captureStdio();
    let second;
    try {
      second = await runSkillsInstallCommand([]);
    } finally {
      io.restore();
    }

    assert.equal(first, 0);
    assert.equal(second, 0);
    assert.equal(readFileSync(upstagePath, "utf8"), afterFirst.upstage);
    assert.equal(readFileSync(claudePath, "utf8"), afterFirst.claude);
    // No warning on a clean idempotent re-run.
    assert.equal(io.err.join(""), "");
    // Only one SKILL.md at each destination (no "SKILL (1).md"-style duplication).
    assert.equal(
      readFileSync(upstagePath, "utf8").split("allowed-tools").length - 1,
      1
    );
  }));
});

test("--target claude installs only .claude/skills/, not .upstage/skills/", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const code = await runSkillsInstallCommand(["--target", "claude"]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, ".claude", "skills", "upstage-utilities", "SKILL.md")), true);
    assert.equal(existsSync(join(dir, ".upstage", "skills", "upstage-utilities", "SKILL.md")), false);
  }));
});

test("--target upstage installs only .upstage/skills/, not .claude/skills/", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const code = await runSkillsInstallCommand(["--target", "upstage"]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, ".upstage", "skills", "upstage-utilities", "SKILL.md")), true);
    assert.equal(existsSync(join(dir, ".claude", "skills", "upstage-utilities", "SKILL.md")), false);
  }));
});

test("--target with an unknown name is a usage error (exit 2), no files written", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const io = captureStdio();
    let code;
    try {
      code = await runSkillsInstallCommand(["--target", "bogus-agent"]);
    } finally {
      io.restore();
    }
    assert.equal(code, 2);
    assert.match(io.err.join(""), /--target must be one of/);
    assert.equal(existsSync(join(dir, ".upstage")), false);
    assert.equal(existsSync(join(dir, ".claude")), false);
  }));
});

test("--target with a missing value is a usage error (exit 2)", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const io = captureStdio();
    let code;
    try {
      code = await runSkillsInstallCommand(["--target"]);
    } finally {
      io.restore();
    }
    assert.equal(code, 2);
  }));
});

test("re-running after a hand-edit warns to stderr and overwrites back to canonical content (exit 0)", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    await runSkillsInstallCommand(["--target", "claude"]);
    const claudePath = join(dir, ".claude", "skills", "upstage-utilities", "SKILL.md");
    writeFileSync(claudePath, "---\nname: upstage-utilities\n---\n\nsomeone hand-edited this copy\n");

    const io = captureStdio();
    let code;
    try {
      code = await runSkillsInstallCommand(["--target", "claude"]);
    } finally {
      io.restore();
    }

    assert.equal(code, 0, "overwriting a hand-edited copy still succeeds (warning only, not a failure)");
    assert.match(io.err.join(""), /already exists with different content/);
    assert.equal(readFileSync(claudePath, "utf8"), readSourceContent());
  }));
});

test("--json outputs a machine-readable array with path/status per target", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const io = captureStdio();
    try {
      await runSkillsInstallCommand(["--json", "--target", "upstage"]);
    } finally {
      io.restore();
    }
    const parsed = JSON.parse(io.out.join(""));
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].status, "created");
    assert.match(parsed[0].path, /upstage-utilities[\\/]SKILL\.md$/);
  }));
});

test("-h/--help prints usage and exits 0 without touching the filesystem", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const io = captureStdio();
    let code;
    try {
      code = await runSkillsInstallCommand(["--help"]);
    } finally {
      io.restore();
    }
    assert.equal(code, 0);
    assert.match(io.out.join(""), /Usage: upstage skills install/);
    assert.equal(existsSync(join(dir, ".upstage")), false);
    assert.equal(existsSync(join(dir, ".claude")), false);
  }));
});

// ── router wiring ───────────────────────────────────────────────────────────

test("router dispatches \"skills install\" to the real handler (not the not-yet-implemented stub)", () => {
  return withTempDir((dir) => withCwd(dir, async () => {
    const io = captureStdio();
    let code;
    try {
      code = await dispatch(["skills", "install"]);
    } finally {
      io.restore();
    }
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, ".claude", "skills", "upstage-utilities", "SKILL.md")), true);
  }));
});

test("router: \"skills install --help\" prints usage via the router's -h/--help interception", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["skills", "install", "--help"]);
    assert.equal(code, 0);
    assert.match(io.out.join(""), /Usage: upstage skills install/);
  } finally {
    io.restore();
  }
});
