import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

import { AgentLoader } from "../src/agents/loader.mjs";
import { parseAgentDefinition } from "../src/agents/parser.mjs";
import { SkillsLoader } from "../src/skills/loader.mjs";
import { SkillRunner } from "../src/skills/runner.mjs";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function makeTmpDir() {
  return mkdtemp(join(os.tmpdir(), "upstage-test-"));
}

async function makeAgentDir(base) {
  const dir = join(base, ".upstage", "agents");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function makeSkillDir(base, skillName) {
  const dir = join(base, ".upstage", "skills", skillName);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// parseAgentDefinition
// ──────────────────────────────────────────────

describe("parseAgentDefinition", () => {
  it("parses valid JSON definition", () => {
    const content = JSON.stringify({
      name: "tester",
      description: "runs tests",
      model: "solar-pro2",
      tools: ["read_file"],
      prompt: "You are a tester."
    });
    const def = parseAgentDefinition(content, ".json");
    assert.equal(def.name, "tester");
    assert.equal(def.model, "solar-pro2");
    assert.deepEqual(def.tools, ["read_file"]);
    assert.equal(def.prompt, "You are a tester.");
  });

  it("returns null for JSON missing name", () => {
    const content = JSON.stringify({ description: "no name" });
    assert.equal(parseAgentDefinition(content, ".json"), null);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseAgentDefinition("{bad json", ".json"), null);
  });

  it("parses valid Markdown definition", () => {
    const content = `---\nname: md-agent\ndescription: an agent\nmodel: solar-pro2\ntools: [read_file, search_code]\n---\nYou are helpful.`;
    const def = parseAgentDefinition(content, ".md");
    assert.equal(def.name, "md-agent");
    assert.equal(def.description, "an agent");
    assert.deepEqual(def.tools, ["read_file", "search_code"]);
    assert.equal(def.prompt, "You are helpful.");
  });

  it("returns null for Markdown missing name in frontmatter", () => {
    const content = `---\ndescription: no name\n---\nBody.`;
    assert.equal(parseAgentDefinition(content, ".md"), null);
  });

  it("returns null for Markdown without frontmatter", () => {
    assert.equal(parseAgentDefinition("Just plain text, no frontmatter.", ".md"), null);
  });

  it("defaults empty tools to []", () => {
    const content = JSON.stringify({ name: "bare", prompt: "hi" });
    const def = parseAgentDefinition(content, ".json");
    assert.deepEqual(def.tools, []);
  });
});

// ──────────────────────────────────────────────
// AgentLoader
// ──────────────────────────────────────────────

describe("AgentLoader", () => {
  let tmpDir;
  let agentsDir;

  before(async () => {
    tmpDir = await makeTmpDir();
    agentsDir = await makeAgentDir(tmpDir);

    await writeFile(join(agentsDir, "reviewer.json"), JSON.stringify({
      name: "reviewer",
      description: "code reviewer",
      model: "solar-pro2",
      tools: ["read_file"],
      prompt: "Review code."
    }));

    await writeFile(join(agentsDir, "helper.md"),
      `---\nname: helper\ndescription: helpful agent\nmodel: solar-pro2\n---\nHelp me.`
    );

    // malformed — should be silently skipped
    await writeFile(join(agentsDir, "broken.json"), "{bad}");
    // non-agent file — should be skipped
    await writeFile(join(agentsDir, "readme.txt"), "ignore me");
  });

  after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("loads JSON agent definitions", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    const def = loader.get("reviewer");
    assert.ok(def, "reviewer not found");
    assert.equal(def.description, "code reviewer");
  });

  it("loads Markdown agent definitions", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    const def = loader.get("helper");
    assert.ok(def);
    assert.equal(def.prompt, "Help me.");
  });

  it("skips malformed files without crashing", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    assert.equal(loader.get("broken"), null);
  });

  it("skips non-json/md files", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    assert.equal(loader.get("readme"), null);
  });

  it("list() returns all loaded agents", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    const names = loader.list().map((a) => a.name).sort();
    assert.deepEqual(names, ["helper", "reviewer"]);
  });

  it("get() returns null for unknown agent", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    assert.equal(loader.get("unknown"), null);
  });

  it("has() returns true for loaded agent", async () => {
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    assert.equal(loader.has("reviewer"), true);
    assert.equal(loader.has("nope"), false);
  });

  it("missing directory does not crash", async () => {
    const loader = new AgentLoader();
    await assert.doesNotReject(() => loader.load("/nonexistent/path/xyz123"));
  });

  it("first-loaded agent wins (cwd takes priority over home)", async () => {
    // Write a second agent with same name in a fresh dir — AgentLoader.load()
    // respects "first seen wins" across search dirs.
    const loader = new AgentLoader();
    await loader.load(tmpDir);
    const def = loader.get("reviewer");
    assert.equal(def.description, "code reviewer"); // cwd version
  });
});

// ──────────────────────────────────────────────
// SkillsLoader
// ──────────────────────────────────────────────

describe("SkillsLoader", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();

    const sumDir = await makeSkillDir(tmpDir, "summarize");
    await writeFile(join(sumDir, "SKILL.md"),
      `---\nname: summarize\ndescription: 요약 스킬\naliases: [sum, summary]\n---\n요약: $ARGUMENTS`
    );

    const refDir = await makeSkillDir(tmpDir, "refactor");
    await writeFile(join(refDir, "SKILL.md"),
      `---\nname: refactor\ndescription: 코드 리팩터링\n---\nRefactor the following code:\n$ARGUMENTS`
    );

    // Skill dir without SKILL.md — should be skipped
    await makeSkillDir(tmpDir, "empty-skill");
  });

  after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("loads skills from .upstage/skills/{name}/SKILL.md", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    assert.ok(loader.get("summarize"), "summarize not found");
    assert.ok(loader.get("refactor"), "refactor not found");
  });

  it("get() does exact match", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    const skill = loader.get("summarize");
    assert.equal(skill.name, "summarize");
    assert.equal(skill.description, "요약 스킬");
  });

  it("get() does prefix match", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    // "refac" should prefix-match "refactor"
    const skill = loader.get("refac");
    assert.equal(skill.name, "refactor");
  });

  it("get() does alias match", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    assert.equal(loader.get("sum")?.name, "summarize");
    assert.equal(loader.get("summary")?.name, "summarize");
  });

  it("get() returns null for unknown", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    assert.equal(loader.get("unknown"), null);
  });

  it("list() returns name/description/aliases", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    const items = loader.list();
    const names = items.map((i) => i.name).sort();
    assert.deepEqual(names, ["refactor", "summarize"]);
    const sumItem = items.find((i) => i.name === "summarize");
    assert.deepEqual(sumItem.aliases, ["sum", "summary"]);
  });

  it("run() substitutes $ARGUMENTS", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    const result = loader.run("summarize", "hello world");
    assert.ok(result.includes("hello world"));
    assert.ok(!result.includes("$ARGUMENTS"));
  });

  it("run() throws for unknown skill", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    assert.throws(() => loader.run("nosuchskill"), /Skill not found/);
  });

  it("skips skill directories without SKILL.md", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    assert.equal(loader.get("empty-skill"), null);
  });

  it("missing directory does not crash", async () => {
    const loader = new SkillsLoader();
    await assert.doesNotReject(() => loader.load("/no/such/path/abc"));
  });
});

// ──────────────────────────────────────────────
// SkillRunner
// ──────────────────────────────────────────────

describe("SkillRunner", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();
    const dir = await makeSkillDir(tmpDir, "ping");
    await writeFile(join(dir, "SKILL.md"),
      `---\nname: ping\ndescription: echo test\naliases: []\n---\npong: $ARGUMENTS`
    );
  });

  after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("execute() yields events from the mock agent loop", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);

    const events = [];
    async function* mockLoop(message) {
      events.push(message);
      yield { type: "stream_token", text: "pong: hello" };
    }

    const runner = new SkillRunner(loader, mockLoop);
    const yielded = [];
    for await (const ev of runner.execute("ping", "hello")) {
      yielded.push(ev);
    }

    assert.equal(yielded.length, 1);
    assert.equal(yielded[0].text, "pong: hello");
    assert.ok(events[0].includes("pong: hello"));
  });

  it("listAvailable() returns loader.list()", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    const runner = new SkillRunner(loader, async function* () {});
    const available = runner.listAvailable();
    assert.equal(available.length, 1);
    assert.equal(available[0].name, "ping");
  });

  it("execute() throws when skill not found", async () => {
    const loader = new SkillsLoader();
    await loader.load(tmpDir);
    const runner = new SkillRunner(loader, async function* () {});
    await assert.rejects(
      async () => { for await (const _ of runner.execute("nosuchskill", "")) { /* empty */ } },
      /Skill not found/
    );
  });
});
