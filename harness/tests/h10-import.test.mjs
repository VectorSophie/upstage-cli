import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadSwebenchFile, writeSwebenchTasksToDir } from "../src/task/loaders/swebench.mjs";
import { loadAiderPolyglotDir, writeAiderTasksToDir } from "../src/task/loaders/aider-polyglot.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(resolve(tmpdir(), "harness-import-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SAMPLE_SWEBENCH_LINE = JSON.stringify({
  instance_id: "astropy__astropy-12907",
  problem_statement: "Modeling fails when units are inconsistent.",
  repo: "astropy/astropy",
  base_commit: "abc123",
  FAIL_TO_PASS: ["tests/modeling/test_units.py::test_inconsistent"],
  PASS_TO_PASS: ["tests/modeling/test_units.py::test_consistent", "tests/modeling/test_units.py::test_basic"],
  environment_setup_commit: "def456"
});

describe("SWE-bench loader", () => {
  test("parseSwebenchInstance — basic fields", async () => {
    await withTempDir(async (dir) => {
      const filePath = resolve(dir, "tasks.jsonl");
      writeFileSync(filePath, SAMPLE_SWEBENCH_LINE + "\n", "utf8");
      const tasks = loadSwebenchFile(filePath);
      assert.equal(tasks.length, 1);
      const t = tasks[0];
      assert.equal(t.id, "astropy__astropy-12907");
      assert.ok(t.prompt.includes("inconsistent"));
      assert.equal(t.checks.fail_to_pass.length, 1);
      assert.equal(t.checks.pass_to_pass.length, 2);
      assert.equal(t.tags[0], "swebench");
      assert.equal(t._meta.baseCommit, "abc123");
    });
  });

  test("fail_to_pass weight sums to ~0.7", async () => {
    await withTempDir(async (dir) => {
      const filePath = resolve(dir, "tasks.jsonl");
      // 2 fail_to_pass tests → each 0.35
      const line = JSON.stringify({
        instance_id: "test-id",
        problem_statement: "p",
        repo: "r",
        base_commit: "b",
        FAIL_TO_PASS: ["t1", "t2"],
        PASS_TO_PASS: []
      });
      writeFileSync(filePath, line + "\n", "utf8");
      const [task] = loadSwebenchFile(filePath);
      const totalWeight = task.checks.fail_to_pass.reduce((s, c) => s + c.weight, 0);
      assert.ok(Math.abs(totalWeight - 0.7) < 0.01, `weight sum ${totalWeight} should be ~0.7`);
    });
  });

  test("skips malformed lines", async () => {
    await withTempDir(async (dir) => {
      const filePath = resolve(dir, "tasks.jsonl");
      writeFileSync(filePath, `{invalid json}\n${SAMPLE_SWEBENCH_LINE}\n`, "utf8");
      const tasks = loadSwebenchFile(filePath);
      assert.equal(tasks.length, 1);
    });
  });

  test("writeSwebenchTasksToDir creates YAML files", async () => {
    await withTempDir(async (dir) => {
      const filePath = resolve(dir, "tasks.jsonl");
      writeFileSync(filePath, SAMPLE_SWEBENCH_LINE + "\n", "utf8");
      const tasks = loadSwebenchFile(filePath);
      const outDir = resolve(dir, "out");
      const written = writeSwebenchTasksToDir(tasks, outDir);
      assert.equal(written.length, 1);
      const content = readFileSync(written[0], "utf8");
      assert.ok(content.includes("astropy__astropy-12907"));
      assert.ok(content.includes("fail_to_pass"));
    });
  });

  test("empty JSONL file → empty array", async () => {
    await withTempDir(async (dir) => {
      const filePath = resolve(dir, "empty.jsonl");
      writeFileSync(filePath, "", "utf8");
      const tasks = loadSwebenchFile(filePath);
      assert.equal(tasks.length, 0);
    });
  });
});

describe("Aider polyglot loader", () => {
  function makeExercise(dir, slug, lang = "python") {
    const ext = lang === "python" ? ".py" : lang === "javascript" ? ".js" : ".ts";
    const exDir = resolve(dir, slug);
    mkdirSync(exDir, { recursive: true });
    writeFileSync(resolve(exDir, `${slug}${ext}`), `# stub\n`, "utf8");
    writeFileSync(resolve(exDir, `${slug}_test${ext}`), `# tests\n`, "utf8");
    return exDir;
  }

  test("loads a single Python exercise", async () => {
    await withTempDir(async (dir) => {
      makeExercise(dir, "two-fer", "python");
      const tasks = loadAiderPolyglotDir(dir);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, "aider-polyglot-two-fer");
      assert.equal(tasks[0]._meta.language, "python");
      assert.ok(tasks[0].tags.includes("exercism"));
    });
  });

  test("loads multiple exercises", async () => {
    await withTempDir(async (dir) => {
      makeExercise(dir, "hello-world", "python");
      makeExercise(dir, "leap", "python");
      const tasks = loadAiderPolyglotDir(dir);
      assert.equal(tasks.length, 2);
    });
  });

  test("detects JavaScript exercises", async () => {
    await withTempDir(async (dir) => {
      makeExercise(dir, "bob", "javascript");
      const tasks = loadAiderPolyglotDir(dir);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]._meta.language, "javascript");
      assert.ok(tasks[0].tags.includes("javascript"));
    });
  });

  test("skips empty directories (no test file)", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(resolve(dir, "empty-ex"), { recursive: true });
      writeFileSync(resolve(dir, "empty-ex", "solution.py"), "# no test file\n");
      const tasks = loadAiderPolyglotDir(dir);
      assert.equal(tasks.length, 0);
    });
  });

  test("includes README as instructions", async () => {
    await withTempDir(async (dir) => {
      const exDir = makeExercise(dir, "two-fer");
      writeFileSync(resolve(exDir, "README.md"), "## Two fer\nCreate a sentence of the form One for X, one for me.", "utf8");
      const tasks = loadAiderPolyglotDir(dir);
      assert.ok(tasks[0].prompt.includes("Two fer"));
    });
  });

  test("writeAiderTasksToDir creates YAML files", async () => {
    await withTempDir(async (dir) => {
      makeExercise(dir, "hello-world");
      const tasks = loadAiderPolyglotDir(dir);
      const outDir = resolve(dir, "out");
      const written = writeAiderTasksToDir(tasks, outDir);
      assert.equal(written.length, 1);
      const content = readFileSync(written[0], "utf8");
      assert.ok(content.includes("aider-polyglot-hello-world"));
      assert.ok(content.includes("fail_to_pass"));
    });
  });
});
