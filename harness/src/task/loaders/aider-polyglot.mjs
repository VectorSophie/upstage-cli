import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, extname, basename } from "node:path";
import { dump as yamlDump } from "js-yaml";

const LANG_MAP = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".go": "go",
  ".rb": "ruby",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp"
};

const TEST_RUNNERS = {
  python: { cmd: "python -m pytest", binaries: ["python", "pytest"] },
  javascript: { cmd: "node --test", binaries: ["node"] },
  typescript: { cmd: "npx ts-node --test", binaries: ["node", "npx"] },
  go: { cmd: "go test ./...", binaries: ["go"] },
  ruby: { cmd: "ruby -Ilib:test", binaries: ["ruby"] },
  rust: { cmd: "cargo test", binaries: ["cargo"] },
  java: { cmd: "mvn test -q", binaries: ["mvn", "java"] },
  csharp: { cmd: "dotnet test --no-build", binaries: ["dotnet"] }
};

function detectLanguage(exerciseDir) {
  const entries = readdirSync(exerciseDir);
  for (const entry of entries) {
    const ext = extname(entry);
    if (LANG_MAP[ext]) return LANG_MAP[ext];
  }
  return "python"; // default
}

function findTestFiles(exerciseDir, lang) {
  const entries = readdirSync(exerciseDir);
  const ext = Object.keys(LANG_MAP).find((e) => LANG_MAP[e] === lang) || ".py";
  return entries.filter(
    (e) => (e.includes("_test") || e.includes("test_") || e.endsWith(".test" + ext)) && extname(e) === ext
  );
}

function readInstructions(exerciseDir) {
  for (const name of [".docs/instructions.md", "instructions.md", "README.md", ".meta/config.json"]) {
    const p = join(exerciseDir, name);
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8");
      if (name.endsWith(".json")) {
        try {
          const cfg = JSON.parse(raw);
          return cfg.blurb || cfg.description || "";
        } catch {
          return "";
        }
      }
      return raw.slice(0, 1000);
    }
  }
  return "";
}

function loadSingleExercise(exerciseDir, slug) {
  const lang = detectLanguage(exerciseDir);
  const runner = TEST_RUNNERS[lang] || TEST_RUNNERS.python;
  const testFiles = findTestFiles(exerciseDir, lang);
  if (testFiles.length === 0) return null;

  const instructions = readInstructions(exerciseDir);
  const testCmd = lang === "python"
    ? `python -m pytest ${testFiles[0]} -x -q`
    : `${runner.cmd} ${testFiles[0]}`;

  return {
    id: `aider-polyglot-${slug}`,
    version: 1,
    description: instructions.slice(0, 200) || `Implement the ${slug} exercise`,
    repo: exerciseDir,
    prompt: instructions
      ? `${instructions}\n\nImplement the solution so all tests pass. Do not modify the test file.`
      : `Implement the ${slug} exercise. Make the tests in ${testFiles[0]} pass. Do not modify the test file.`,
    context: { strategy: "default", maxFiles: 20, includeTests: true },
    sandbox: { type: "native", timeout: 60, allowedBinaries: runner.binaries },
    agent: { permissions: "acceptEdits", maxTurns: 6, maxTokens: 16384 },
    checks: {
      fail_to_pass: [{ id: "tests", command: testCmd, timeout: 30, weight: 1.0 }],
      pass_to_pass: [],
      custom: []
    },
    scoring: {
      weights: { checks: 0.7, patchMinimality: 0.15, toolCallCount: 0.1, costUsd: 0.05, speedMs: 0 }
    },
    tags: ["aider-polyglot", lang, "exercism"],
    difficulty: "easy",
    _meta: { source: "aider-polyglot", language: lang, exerciseSlug: slug }
  };
}

export function loadAiderPolyglotDir(dir) {
  const absDir = resolve(dir);
  const tasks = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read directory: ${absDir}`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const task = loadSingleExercise(join(absDir, entry.name), entry.name);
      if (task) tasks.push(task);
    } catch {
      // skip invalid exercises
    }
  }
  return tasks;
}

export function writeAiderTasksToDir(tasks, outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const task of tasks) {
    const fileName = `${task.id}.yaml`;
    const filePath = resolve(outDir, fileName);
    writeFileSync(filePath, yamlDump(task, { lineWidth: 120 }), "utf8");
    written.push(filePath);
  }
  return written;
}
