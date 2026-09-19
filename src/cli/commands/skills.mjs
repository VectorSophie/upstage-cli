// `upstage skills list/show` — Task 12.5 of the 3.2.0 release plan.
//
// FILE-ORGANIZATION JUDGMENT CALL (per the task's own instructions to
// document this): the plan text says this "extends Task 7.9's file", but
// Task 7.9 actually created `src/cli/commands/skills-install.mjs`, a file
// whose header is entirely about the install command's specific concerns
// (idempotency, --target resolution, byte-identical-copy semantics) — not a
// generically-named `skills.mjs`. Renaming it would churn a committed,
// already-tested file for no functional gain (list/show share none of
// install's helpers — install reads a bundled skill FILE via
// `readSourceContent()`/`installOne()`, whereas list/show read the SAME
// `SkillsLoader` every other on-disk-skill consumer in this codebase already
// uses). So: a NEW `skills.mjs` (this file) holds `list`/`show`, following
// the `doctor.mjs`/`mcp.mjs` gather*/format*Human/format*Json/run*Command
// pattern; `skills-install.mjs` is untouched and keeps owning `install`. The
// router (src/cli/router.mjs) imports `runSkillsInstallCommand` from the old
// file and `runSkillsListCommand`/`runSkillsShowCommand` from this one.
//
// `SkillsLoader` (src/skills/loader.mjs) methods used here — `load(cwd)`,
// `list()` → `[{name, description, aliases, license}]`, `get(name)` → the
// full skill record (adds `prompt`) or `null`.

import { SkillsLoader } from "../../skills/loader.mjs";

async function loadSkills(cwd) {
  return new SkillsLoader().load(cwd);
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `[{name, description, aliases, license}]` (SkillsLoader.list()'s
 *  own shape). Accepts a pre-loaded `loader` for tests. */
export async function gatherSkillsList({ cwd = process.cwd(), loader } = {}) {
  const l = loader || (await loadSkills(cwd));
  return l.list();
}

export function formatListHuman(rows) {
  if (rows.length === 0) return "No skills found.\n";
  return rows.map((s) => `${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n") + "\n";
}

export function formatListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage skills list [--json]",
      "",
      "Lists every skill found (.upstage/skills/, .claude/skills/, the",
      "package-bundled pack, and the home directory).",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, description, aliases, license}]"
    ].join("\n") + "\n"
  );
}

export async function runSkillsListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const json = rest.includes("--json");
  const rows = await gatherSkillsList({ cwd: process.cwd() });
  process.stdout.write(json ? formatListJson(rows) : formatListHuman(rows));
  return 0;
}

// ── show ─────────────────────────────────────────────────────────────────

/** Returns `{ result: <full skill record, incl. prompt> }` or `{ error,
 *  code: 2 }`. `SkillsLoader.get()` also does prefix/alias matching, not
 *  just exact-name lookup — preserved here rather than reimplemented. */
export async function gatherSkillsShow({ cwd = process.cwd(), loader, name } = {}) {
  if (!name) return { error: "missing required <name> argument", code: 2 };
  const l = loader || (await loadSkills(cwd));
  const skill = l.get(name);
  if (!skill) return { error: `no skill named '${name}' found`, code: 2 };
  return { result: skill };
}

export function formatShowHuman(skill) {
  const lines = [
    `name: ${skill.name}`,
    `description: ${skill.description || "(none)"}`,
    `aliases: ${skill.aliases && skill.aliases.length > 0 ? skill.aliases.join(", ") : "(none)"}`,
    `license: ${skill.license || "(none)"}`,
    "prompt:",
    skill.prompt || "(none)"
  ];
  return lines.join("\n") + "\n";
}

export function formatShowJson(skill) {
  return `${JSON.stringify(skill, null, 2)}\n`;
}

function printShowUsage() {
  process.stdout.write(
    [
      "Usage: upstage skills show <name> [--json]",
      "",
      "Prints one skill's full detail (description/aliases/license/prompt).",
      "Matches by exact name, prefix, or alias (same resolution SkillsLoader",
      "uses everywhere else).",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

export async function runSkillsShowCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printShowUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const name = positionals[0];

  const outcome = await gatherSkillsShow({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage skills show: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatShowJson(outcome.result) : formatShowHuman(outcome.result));
  return 0;
}
