import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMentions, resolveMentions } from "../src/agent/file-mentions.mjs";

test("extractMentions finds @paths and dedupes, dropping trailing punctuation", () => {
  const m = extractMentions("look at @src/a.mjs and @src/a.mjs, also @README.md.");
  assert.deepEqual(m, ["src/a.mjs", "README.md"]);
});

test("extractMentions ignores emails / non-leading @", () => {
  // '@' not preceded by whitespace/start (e.g. inside an email) is not a mention.
  const m = extractMentions("mail me at user@example.com");
  assert.equal(m.includes("example.com"), false);
});

test("resolveMentions reads in-cwd files into a context block", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mention-"));
  try {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.mjs"), "export const A = 1;");
    const { mentions, contextBlock } = await resolveMentions("explain @src/a.mjs", cwd);
    assert.equal(mentions[0].ok, true);
    assert.match(contextBlock, /export const A = 1/);
    assert.match(contextBlock, /src[\\/]a\.mjs/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("resolveMentions reports missing files and blocks paths outside cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mention-"));
  try {
    const { mentions, contextBlock } = await resolveMentions("see @nope.txt and @../escape.txt", cwd);
    assert.equal(contextBlock, "");
    const missing = mentions.find((m) => m.path === "nope.txt");
    const escape = mentions.find((m) => m.path === "../escape.txt");
    assert.equal(missing.ok, false);
    assert.equal(escape.ok, false);
    assert.match(escape.error, /outside workspace/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
