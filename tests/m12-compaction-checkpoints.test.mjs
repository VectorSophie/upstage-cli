import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/core/context-manager.mjs";
import { CheckpointManager } from "../src/core/checkpoints.mjs";

// ─── ContextManager ────────────────────────────────────────────────────────

test("ContextManager.getTokenCount estimates ASCII tokens", () => {
  const cm = new ContextManager(1000);
  const msgs = [{ role: "user", content: "hello world" }]; // 11 chars / 4 = ~3 tokens
  const count = cm.getTokenCount(msgs);
  assert.ok(count > 0 && count < 10, `expected small count, got ${count}`);
});

test("ContextManager.getTokenCount handles Korean content (CJK ratio)", () => {
  const cm = new ContextManager(1000);
  const korean = "안녕하세요 세상"; // pure Korean — 2.5 chars/token
  const msgs = [{ role: "user", content: korean }];
  const asciiMsgs = [{ role: "user", content: "hello world" }];
  // Korean tokens-per-char should be higher (more tokens per char due to lower ratio)
  const koreanCount = cm.getTokenCount(msgs);
  const asciiCount = cm.getTokenCount(asciiMsgs);
  // 8 Korean chars / 2.5 ≈ 3.2 tokens,  11 ASCII chars / 4 = 2.75 tokens
  // both reasonable and Korean ≥ ascii per char
  assert.ok(koreanCount > 0);
  assert.ok(asciiCount > 0);
});

test("ContextManager.getTokenCount handles tool_calls array", () => {
  const cm = new ContextManager(1000);
  const msg = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"x"}' } }]
  };
  const count = cm.getTokenCount([msg]);
  assert.ok(count > 0);
});

test("ContextManager.getTokenCount handles null content", () => {
  const cm = new ContextManager(1000);
  const msgs = [{ role: "assistant", content: null }];
  assert.equal(cm.getTokenCount(msgs), 0);
});

test("ContextManager.shouldCompact returns true at >= 80% threshold", () => {
  const cm = new ContextManager(100, 0.8); // 80 token threshold
  // Generate a message that exceeds 80 tokens (80 * 4 = 320 chars minimum)
  const big = "a".repeat(400);
  assert.ok(cm.shouldCompact([{ role: "user", content: big }]));
});

test("ContextManager.shouldCompact returns false under threshold", () => {
  const cm = new ContextManager(10000, 0.8);
  assert.ok(!cm.shouldCompact([{ role: "user", content: "hi" }]));
});

test("ContextManager.microCompact truncates old tool messages", () => {
  const cm = new ContextManager(10000);
  // With recentTurns=2: boundary = max(0, 9 - 4) = 5
  // Messages at index 0-4 are "old", 5-8 are "recent"
  const msgs = [
    { role: "tool", tool_call_id: "c0", content: "a".repeat(300) }, // index 0 — old, truncate
    { role: "user", content: "turn2" },                              // index 1 — old
    { role: "assistant", content: "resp2" },                         // index 2 — old
    { role: "user", content: "turn3" },                              // index 3 — old
    { role: "assistant", content: "resp3" },                         // index 4 — old
    { role: "user", content: "turn4" },                              // index 5 — recent
    { role: "assistant", content: "resp4" },                         // index 6 — recent
    { role: "user", content: "turn5" },                              // index 7 — recent
    { role: "tool", tool_call_id: "c1", content: "b".repeat(300) }, // index 8 — recent, keep
  ];
  const result = cm.microCompact(msgs, 2);
  // First tool message (index 0) is old — should be truncated
  assert.ok(result[0].content.length <= 115, `old tool content should be truncated, got ${result[0].content.length}`);
  // Last tool message (index 8, recent) should NOT be truncated
  assert.equal(result[result.length - 1].content.length, 300);
});

test("ContextManager.microCompact leaves recent messages intact", () => {
  const cm = new ContextManager(10000);
  const msgs = [
    { role: "user", content: "query" },
    { role: "assistant", content: "answer" },
  ];
  const result = cm.microCompact(msgs, 5);
  assert.deepEqual(result, msgs);
});

test("ContextManager.compact inserts summary and keeps keepRecent messages", () => {
  const cm = new ContextManager(100, 0.8);
  // Make many messages so compact triggers full path
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: "user", content: "x".repeat(40) });
    msgs.push({ role: "assistant", content: "y".repeat(40) });
  }
  const result = cm.compact(msgs, 4);
  // First message should be the summary
  assert.ok(result[0].content.includes("[Context compacted"));
  // Should have summary + 4 recent messages
  assert.ok(result.length <= 5);
});

test("ContextManager.getStats tracks compaction count", () => {
  const cm = new ContextManager(100, 0.8);
  const msgs = [{ role: "user", content: "a".repeat(400) }];
  cm.compact(msgs);
  const stats = cm.getStats();
  assert.equal(stats.compactionCount, 1);
  assert.ok(stats.lastPreCompactTokens > 0);
});

test("ContextManager.addMessage auto-compacts when over threshold", () => {
  const cm = new ContextManager(50, 0.8); // tiny limit
  let msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs = cm.addMessage(msgs, { role: "user", content: "a".repeat(50) });
  }
  // Should have compacted — messages should not be 30 * 50 char messages
  const totalChars = msgs.reduce((s, m) => s + (m.content?.length || 0), 0);
  assert.ok(totalChars < 30 * 50, "expected compaction to reduce total chars");
});

// ─── CheckpointManager ─────────────────────────────────────────────────────

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "upstage-ckpt-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("CheckpointManager.save creates checkpoint file", async () => {
  await withTmpDir(async (dir) => {
    const ckptDir = join(dir, "checkpoints");
    const cm = new CheckpointManager(ckptDir);

    const testFile = join(dir, "file.txt");
    await writeFile(testFile, "original content");

    const record = await cm.save(testFile);

    assert.ok(record.id.startsWith("ckpt_"));
    assert.equal(record.content, "original content");
    assert.equal(record.filePath, testFile);
    assert.equal(cm.history.length, 1);
  });
});

test("CheckpointManager.undo restores file content", async () => {
  await withTmpDir(async (dir) => {
    const ckptDir = join(dir, "checkpoints");
    const cm = new CheckpointManager(ckptDir);

    const testFile = join(dir, "file.txt");
    await writeFile(testFile, "original content");

    await cm.save(testFile);

    // Modify the file
    await writeFile(testFile, "modified content");

    const result = await cm.undo();
    assert.ok(result.restored);

    const restored = await readFile(testFile, "utf8");
    assert.equal(restored, "original content");
    assert.equal(cm.history.length, 0);
  });
});

test("CheckpointManager.undo on new file deletes it", async () => {
  await withTmpDir(async (dir) => {
    const ckptDir = join(dir, "checkpoints");
    const cm = new CheckpointManager(ckptDir);

    const testFile = join(dir, "newfile.txt");
    // File does not exist yet — save records content: null
    const record = await cm.save(testFile);
    assert.equal(record.content, null);

    // Create the file afterwards (simulating what write_file would do)
    await writeFile(testFile, "new content");

    await cm.undo();

    // File should have been deleted
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(testFile));
  });
});

test("CheckpointManager.list returns recent checkpoints", async () => {
  await withTmpDir(async (dir) => {
    const ckptDir = join(dir, "checkpoints");
    const cm = new CheckpointManager(ckptDir);

    const testFile = join(dir, "file.txt");
    await writeFile(testFile, "v1");

    await cm.save(testFile);
    await cm.save(testFile);
    await cm.save(testFile);

    const list = await cm.list(2);
    assert.equal(list.length, 2);
  });
});

test("CheckpointManager.clear removes all checkpoints", async () => {
  await withTmpDir(async (dir) => {
    const ckptDir = join(dir, "checkpoints");
    const cm = new CheckpointManager(ckptDir);

    const testFile = join(dir, "file.txt");
    await writeFile(testFile, "content");

    await cm.save(testFile);
    await cm.save(testFile);

    await cm.clear();
    assert.equal(cm.history.length, 0);
    assert.deepEqual(await cm.list(), []);
  });
});

test("CheckpointManager enforces max 50 history entries", async () => {
  await withTmpDir(async (dir) => {
    const ckptDir = join(dir, "checkpoints");
    const cm = new CheckpointManager(ckptDir);

    const testFile = join(dir, "file.txt");
    await writeFile(testFile, "content");

    for (let i = 0; i < 55; i++) {
      await cm.save(testFile);
    }
    assert.equal(cm.history.length, 50);
  });
});

test("CheckpointManager.undo returns null when history is empty", async () => {
  await withTmpDir(async (dir) => {
    const cm = new CheckpointManager(join(dir, "checkpoints"));
    const result = await cm.undo();
    assert.equal(result, null);
  });
});
