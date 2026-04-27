import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { PatchTracker } from "../src/tracking/patch-tracker.mjs";

function initRepo(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@harness"', { cwd: dir });
  execSync('git config user.name "Harness Test"', { cwd: dir });
}

function commit(dir, msg = "initial") {
  execSync("git add -A", { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
  return execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
}

// ── captureInitial ────────────────────────────────────────────────────────────

describe("PatchTracker — captureInitial", () => {
  it("returns a 40-char SHA for an existing git repo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-init-"));
    try {
      initRepo(tmp);
      writeFileSync(join(tmp, "file.txt"), "hello");
      commit(tmp);
      const tracker = new PatchTracker(tmp);
      const sha = await tracker.captureInitial();
      assert.match(sha, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("initialises repo and commits when directory is not a git repo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-nongit-"));
    try {
      writeFileSync(join(tmp, "file.txt"), "content");
      const tracker = new PatchTracker(tmp);
      const sha = await tracker.captureInitial();
      assert.match(sha, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── captureDiff ───────────────────────────────────────────────────────────────

describe("PatchTracker — captureDiff", () => {
  it("detects no change when nothing modified", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-nochange-"));
    try {
      writeFileSync(join(tmp, "app.py"), "x = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.filesChanged.length, 0);
      assert.equal(diff.linesAdded, 0);
      assert.equal(diff.linesRemoved, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects single-file single-line addition", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-add-"));
    try {
      writeFileSync(join(tmp, "app.py"), "x = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      // Agent "fixes" the file
      writeFileSync(join(tmp, "app.py"), "x = 1\ny = 2\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.filesChanged.length, 1);
      assert.equal(diff.linesAdded, 1);
      assert.equal(diff.linesRemoved, 0);
      assert.ok(diff.unifiedDiff.includes("+y = 2"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects multi-file changes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-multi-"));
    try {
      writeFileSync(join(tmp, "a.py"), "a = 1\n");
      writeFileSync(join(tmp, "b.py"), "b = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "a.py"), "a = 2\n");
      writeFileSync(join(tmp, "b.py"), "b = 2\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.filesChanged.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes unified diff text", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-unified-"));
    try {
      writeFileSync(join(tmp, "x.py"), "old line\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "x.py"), "new line\n");
      const diff = await tracker.captureDiff(initial);
      assert.ok(diff.unifiedDiff.includes("---") || diff.unifiedDiff.includes("+++"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("counts line removals", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-remove-"));
    try {
      writeFileSync(join(tmp, "app.py"), "line1\nline2\nline3\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "app.py"), "line1\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.linesRemoved, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── integration: captureInitial then captureDiff ──────────────────────────────

describe("PatchTracker — integration round-trip", () => {
  it("initial SHA is preserved in diff output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-round-"));
    try {
      writeFileSync(join(tmp, "main.py"), "def main(): pass\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "main.py"), "def main():\n    return 42\n");
      const diff = await tracker.captureDiff(initial);
      assert.equal(diff.initialCommit, initial);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("new files appear in filesChanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "h4-newfile-"));
    try {
      writeFileSync(join(tmp, "existing.py"), "x = 1\n");
      const tracker = new PatchTracker(tmp);
      const initial = await tracker.captureInitial();
      writeFileSync(join(tmp, "new_module.py"), "y = 2\n");
      const diff = await tracker.captureDiff(initial);
      assert.ok(diff.filesChanged.includes("new_module.py"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
