import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { buildIntelligenceIndex } from "../src/indexer/intelligence.js";

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
