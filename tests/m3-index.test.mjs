import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { buildIntelligenceIndex } from "../src/indexer/intelligence.mjs";

async function makeWorkspace() {
  const dir = await mkdtemp(join(os.tmpdir(), "upstage-cli-m3-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "ignored"), { recursive: true });

  await writeFile(join(dir, ".gitignore"), "ignored/\n", "utf8");
  await writeFile(
    join(dir, "src", "app.js"),
    "import { helper } from './helper.js'\nexport function run() { return helper(); }\n",
    "utf8"
  );
  await writeFile(join(dir, "src", "helper.js"), "export function helper() { return 1; }\n", "utf8");
  await writeFile(join(dir, "ignored", "secret.js"), "export const leaked = true;\n", "utf8");

  return dir;
}

test("intelligence index respects .gitignore and persists signatures", async () => {
  const cwd = await makeWorkspace();
  try {
    const index = await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });
    const indexedFiles = Object.keys(index.importsByFile);

    assert.ok(indexedFiles.includes("src/app.js"));
    assert.ok(indexedFiles.includes("src/helper.js"));
    assert.ok(!indexedFiles.includes("ignored/secret.js"));
    assert.equal(index.parserMode, "tree-sitter-ready-regex");
    assert.ok(index.fileSignatures["src/app.js"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("intelligence index reuses cache when file signatures are unchanged", async () => {
  const cwd = await makeWorkspace();
  try {
    const first = await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });
    const second = await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("intelligence index reindexes only the changed file, keeping other files' symbols", async () => {
  const cwd = await makeWorkspace();
  try {
    await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });

    // Only touch helper.js — app.js's cached symbols should be reused as-is.
    await writeFile(
      join(cwd, "src", "helper.js"),
      "export function helper() { return 1; }\nexport function helperTwo() { return 2; }\n",
      "utf8"
    );

    const updated = await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });
    assert.equal(updated.fromCache, false);

    const names = updated.symbols.map((s) => s.name);
    assert.ok(names.includes("run"), "unchanged file's symbol (run) should be preserved");
    assert.ok(names.includes("helper"), "changed file's existing symbol should still be present");
    assert.ok(names.includes("helperTwo"), "changed file's new symbol should be picked up");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("intelligence index drops symbols for a file that was deleted", async () => {
  const cwd = await makeWorkspace();
  try {
    const first = await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });
    assert.ok(first.symbols.some((s) => s.file === "src/helper.js"));

    await rm(join(cwd, "src", "helper.js"));

    const updated = await buildIntelligenceIndex(cwd, { maxFiles: 200, maxDepth: 8 });
    assert.ok(!updated.symbols.some((s) => s.file === "src/helper.js"));
    assert.ok(!Object.keys(updated.importsByFile).includes("src/helper.js"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
