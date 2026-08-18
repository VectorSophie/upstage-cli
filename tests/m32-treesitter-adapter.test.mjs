import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSourceFile } from "../src/indexer/parsers/adapter.mjs";

// Regression test for a real bug: the tree-sitter wasm grammar path used to
// be resolved via process.cwd(), which only ever worked by coincidence when
// running from inside this repo (the one place node_modules/tree-sitter-*
// happens to exist). Any real target project being indexed doesn't have our
// own tree-sitter deps in its node_modules, so this silently degraded to the
// regex fallback for every actual user. Assert real tree-sitter parsing
// engages regardless of cwd.
test("parseSourceFile resolves tree-sitter grammars independent of cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adapter-cwd-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const result = await parseSourceFile({
      filePath: "app.js",
      relativePath: "app.js",
      content: "function foo() { return 1; }"
    });
    assert.equal(result.parser, "tree-sitter");
    assert.ok(result.symbols.some((s) => s.name === "foo"));
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
