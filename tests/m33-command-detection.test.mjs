import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectProjectCommands } from "../src/cli/lib/command-detection.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-command-detection-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writePackageJson(dir, scripts) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }));
}

// --- happy path: a realistic scripts block ---

test("detectProjectCommands identifies lint/typecheck/test from a realistic scripts block", () => {
  return withTempDir(async (dir) => {
    writePackageJson(dir, {
      lint: "eslint src/",
      typecheck: "tsc --noEmit",
      test: "node --test \"tests/*.test.mjs\""
    });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.lint, { script: "lint", command: "eslint src/" });
    assert.deepEqual(result.typecheck, { script: "typecheck", command: "tsc --noEmit" });
    assert.deepEqual(result.test, { script: "test", command: "node --test \"tests/*.test.mjs\"" });
  });
});

// --- alternate key spellings ---

test("detectProjectCommands recognizes 'tsc' as a typecheck script when there's no 'typecheck'/'type-check' key", () => {
  return withTempDir(async (dir) => {
    writePackageJson(dir, { tsc: "tsc --noEmit", build: "vite build" });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.typecheck, { script: "tsc", command: "tsc --noEmit" });
  });
});

test("detectProjectCommands recognizes 'type-check' as a typecheck script", () => {
  return withTempDir(async (dir) => {
    writePackageJson(dir, { "type-check": "tsc --noEmit" });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.typecheck, { script: "type-check", command: "tsc --noEmit" });
  });
});

test("detectProjectCommands matches a script name containing 'lint' as a substring (e.g. 'lint:fix')", () => {
  return withTempDir(async (dir) => {
    writePackageJson(dir, { "lint:fix": "eslint --fix src/" });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.lint, { script: "lint:fix", command: "eslint --fix src/" });
  });
});

// --- priority ordering: when more than one plausible match exists for a category ---

test("detectProjectCommands prefers an exact/more-specific typecheck key ('typecheck') over a looser one ('tsc') when both are present", () => {
  return withTempDir(async (dir) => {
    // Both scripts exist; TYPECHECK_KEYS in command-detection.mjs lists
    // "typecheck" before "tsc", so a project that has BOTH keys should
    // resolve to the more descriptive "typecheck" one, not just whichever
    // key happens to be enumerated first by Object.entries().
    writePackageJson(dir, {
      tsc: "tsc --noEmit --project tsconfig.strict.json",
      typecheck: "tsc --noEmit"
    });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.typecheck, { script: "typecheck", command: "tsc --noEmit" });
  });
});

test("detectProjectCommands prefers the first-declared matching script within a single priority key when scripts object has multiple candidates", () => {
  return withTempDir(async (dir) => {
    // Two scripts both containing "lint" as a substring — JS object key
    // order is insertion order, so "lint" (declared first) should win over
    // "lint:strict" for the single LINT_KEYS entry "lint".
    writePackageJson(dir, {
      lint: "eslint src/",
      "lint:strict": "eslint --max-warnings=0 src/"
    });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.lint, { script: "lint", command: "eslint src/" });
  });
});

// --- independence across categories ---

test("detectProjectCommands reports only what's actually present, independently per category", () => {
  return withTempDir(async (dir) => {
    writePackageJson(dir, { test: "vitest run" });
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result.test, { script: "test", command: "vitest run" });
    assert.equal(result.lint, null);
    assert.equal(result.typecheck, null);
  });
});

// --- absence paths (never throws, always returns the {lint,typecheck,test} shape) ---

test("detectProjectCommands returns all-null when package.json has no scripts field", () => {
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result, { lint: null, typecheck: null, test: null });
  });
});

test("detectProjectCommands returns all-null when package.json doesn't exist", () => {
  return withTempDir(async (dir) => {
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result, { lint: null, typecheck: null, test: null });
  });
});

test("detectProjectCommands returns all-null (never throws) for malformed JSON", () => {
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, "package.json"), "{ not valid json");
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result, { lint: null, typecheck: null, test: null });
  });
});

test("detectProjectCommands treats a non-object scripts field as absent rather than throwing", () => {
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: "not-an-object" }));
    const result = await detectProjectCommands(dir);
    assert.deepEqual(result, { lint: null, typecheck: null, test: null });
  });
});

test("detectProjectCommands defaults cwd to process.cwd() when omitted", async () => {
  // This repo's own package.json (the real process.cwd() while running
  // tests) has lint/test scripts — just check it resolves without error and
  // returns the documented shape rather than asserting exact values, since
  // this varies with wherever the suite happens to run from.
  const result = await detectProjectCommands();
  assert.ok("lint" in result && "typecheck" in result && "test" in result);
});
