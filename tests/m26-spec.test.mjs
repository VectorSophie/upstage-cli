import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSpec, readSpecs } from "../src/core/spec.mjs";

test("appendSpec creates UPSTAGE.md with a Specs section", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-"));
  try {
    const { path } = await appendSpec(cwd, "Auth uses JWT with 15m access tokens.");
    const content = await readFile(path, "utf8");
    assert.match(content, /## Specs/);
    assert.match(content, /JWT with 15m/);
    const specs = await readSpecs(cwd);
    assert.match(specs, /JWT with 15m/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("appendSpec inserts under an existing Specs heading and preserves other content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-"));
  try {
    await writeFile(join(cwd, "UPSTAGE.md"), "# Project\n\nSome guidance.\n\n## Specs\n- (2026-01-01) old spec\n\n## Other\nkeep me\n");
    await appendSpec(cwd, "new spec");
    const content = await readFile(join(cwd, "UPSTAGE.md"), "utf8");
    assert.match(content, /new spec/);
    assert.match(content, /old spec/);
    assert.match(content, /keep me/);
    // readSpecs returns only the Specs section, not the Other section.
    const specs = await readSpecs(cwd);
    assert.match(specs, /new spec/);
    assert.equal(specs.includes("keep me"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("appendSpec rejects empty text; readSpecs returns '' when absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-"));
  try {
    await assert.rejects(() => appendSpec(cwd, "   "), /required/);
    assert.equal(await readSpecs(cwd), "");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
