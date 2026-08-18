import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillsLoader } from "../src/skills/loader.mjs";
import { buildSystemPrompt } from "../src/core/system-prompt.mjs";
import { loadSkillTool } from "../src/tools/builtin/load-skill.mjs";
import { executeCommand } from "../src/ui/commands.mjs";

// ─── SkillsLoader: package-bundled first-party pack (docs/skills-research-aug2026.md) ───

test("SkillsLoader discovers the package-bundled starter pack from a cwd with no project skills of its own", async () => {
  const loader = new SkillsLoader();
  await loader.load("/nonexistent-cwd-for-skills-test");
  assert.ok(loader.get("korean-pii-guard"), "korean-pii-guard not found");
  assert.ok(loader.get("groundedness-check"), "groundedness-check not found");
  assert.ok(loader.get("toss-payments-integration"), "toss-payments-integration not found");
  assert.ok(loader.get("document-ai-parsing"), "document-ai-parsing not found");
  assert.ok(loader.get("semantic-code-search"), "semantic-code-search not found");
});

// ─── k-skill import (MIT, docs/skills-research-aug2026.md §5, skills/THIRD_PARTY_NOTICES.md) ───

test("bundled pack includes the 19 adapted k-skill imports, each with a non-empty description and body", async () => {
  const loader = new SkillsLoader();
  await loader.load("/nonexistent-cwd-for-skills-test");
  const imported = [
    "ktx-booking", "seoul-subway-arrival", "korean-transit-route",
    "nts-business-registration", "nts-tax-delinquency", "zipcode-search",
    "korean-holiday-calendar", "k-dart", "korean-stock-search", "lotto-results",
    "k-schoollunch-menu", "household-waste-info", "fine-dust-location",
    "korea-weather", "kbo-results", "kleague-results", "korean-spell-check",
    "korean-humanizer", "housing-official-price"
  ];
  for (const name of imported) {
    const skill = loader.get(name);
    assert.ok(skill, `${name} not found`);
    assert.ok(skill.description.length > 0, `${name} has an empty description`);
    assert.ok(skill.prompt.length > 100, `${name} has a suspiciously short body`);
    assert.equal(skill.license, "MIT");
  }
});

test("SkillsLoader parses a block-scalar (>) description across the bundled skills", async () => {
  const loader = new SkillsLoader();
  await loader.load("/nonexistent-cwd-for-skills-test");
  const skill = loader.get("korean-pii-guard");
  // Folded (>) block scalars join with spaces, not literal newlines.
  assert.doesNotMatch(skill.description, /\n/);
  assert.match(skill.description, /주민등록번호/);
});

test("SkillsLoader: project-local .upstage/skills overrides a same-named bundled skill", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "skills-override-"));
  try {
    const dir = join(cwd, ".upstage", "skills", "korean-pii-guard");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: korean-pii-guard\ndescription: project override\n---\noverridden body", "utf8");

    const loader = new SkillsLoader();
    await loader.load(cwd);
    const skill = loader.get("korean-pii-guard");
    assert.equal(skill.description, "project override");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("SkillsLoader discovers .claude/skills/ (Agent Skills format interop)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "skills-interop-"));
  try {
    const dir = join(cwd, ".claude", "skills", "example-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: example-skill\ndescription: an interop-discovered skill\n---\nbody", "utf8");

    const loader = new SkillsLoader();
    await loader.load(cwd);
    assert.equal(loader.get("example-skill")?.description, "an interop-discovered skill");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("SkillsLoader discovers a skills/ dir shipped alongside a compiled executable (process.execPath sibling)", async () => {
  // Simulates `bun build --compile` distribution: import.meta.url has no
  // real disk location there, so PACKAGE_SKILLS_DIR alone can't be relied
  // on — the loader also checks dirname(process.execPath)/skills.
  const fakeExecDir = await mkdtemp(join(tmpdir(), "skills-exec-sibling-"));
  const originalExecPath = process.execPath;
  try {
    const dir = join(fakeExecDir, "skills", "sibling-only-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: sibling-only-skill\ndescription: found next to the binary\n---\nbody", "utf8");

    Object.defineProperty(process, "execPath", { value: join(fakeExecDir, "upstage"), configurable: true });
    const loader = new SkillsLoader();
    await loader.load("/nonexistent-cwd-for-skills-test");
    assert.equal(loader.get("sibling-only-skill")?.description, "found next to the binary");
  } finally {
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    await rm(fakeExecDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ─── system prompt integration ──────────────────────────────────────────

test("buildSystemPrompt folds a skills catalog in when given a skills list, and omits it when empty", () => {
  const withSkills = buildSystemPrompt({
    cwd: process.cwd(),
    language: "en",
    skills: [{ name: "korean-pii-guard", description: "does the thing" }]
  });
  assert.match(withSkills.staticPrefix, /korean-pii-guard: does the thing/);
  assert.match(withSkills.staticPrefix, /load_skill/);

  const withoutSkills = buildSystemPrompt({ cwd: process.cwd(), language: "en", skills: [] });
  assert.doesNotMatch(withoutSkills.staticPrefix, /Skills available/);
});

// ─── load_skill tool (autonomous invocation path) ───────────────────────

test("load_skill tool reads from context.runtimeCache.skillsLoader and returns the full prompt", async () => {
  const loader = new SkillsLoader();
  await loader.load("/nonexistent-cwd-for-skills-test");

  const result = await loadSkillTool.execute({ name: "groundedness-check" }, { runtimeCache: { skillsLoader: loader } });
  assert.equal(result.name, "groundedness-check");
  assert.match(result.instructions, /check_groundedness/);
  assert.equal(result.license, "MIT");
});

test("load_skill tool throws with the available-skills list for an unknown name", async () => {
  const loader = new SkillsLoader();
  await loader.load("/nonexistent-cwd-for-skills-test");
  await assert.rejects(
    () => loadSkillTool.execute({ name: "nonexistent-skill" }, { runtimeCache: { skillsLoader: loader } }),
    /Unknown skill: nonexistent-skill/
  );
});

test("load_skill tool throws cleanly when no skills loader is in context", async () => {
  await assert.rejects(() => loadSkillTool.execute({ name: "anything" }, {}), /Unknown skill/);
});

// ─── manual /skill-name slash-command fallback (executeCommand) ─────────

test("executeCommand routes an unrecognized /command to a matching skill via _skillsLoader", async () => {
  const loader = new SkillsLoader();
  await loader.load("/nonexistent-cwd-for-skills-test"); // package-bundled pack only, no project skills

  const cwd = await mkdtemp(join(tmpdir(), "skills-manual-"));
  try {
    const dir = join(cwd, ".upstage", "skills", "greet");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: greet\ndescription: says hi\n---\nSay hello to: $ARGUMENTS", "utf8");
    await loader.load(cwd);

    const result = await executeCommand("/greet world", { _skillsLoader: loader });
    assert.equal(result.response, "__run_skill__");
    assert.match(result.runPrompt, /Say hello to: world/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("executeCommand still reports unknown command when no skill matches", async () => {
  const result = await executeCommand("/totally-not-a-thing", { _skillsLoader: null });
  assert.match(result.response, /알 수 없는 명령어/);
});
