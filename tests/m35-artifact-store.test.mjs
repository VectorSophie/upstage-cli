// Tests for the 3.3.0 evidence store (src/runtime/artifacts.mjs, Task A.1 of
// docs/superpowers/plans/2026-09-19-3.3.0-implementation-plan.md) — the
// shared artifact store that Docker execution, browser verification, and
// the vision sidecar will all write evidence (docker logs, screenshots,
// console captures, vision responses) into instead of inlining bytes into
// session.toolResults.
//
// Same no-injection-seam situation as tests/m33-sessions-cli.test.mjs:
// sessionRoot() is hardcoded to os.homedir()/.upstage-cli/sessions, so these
// tests use a random UUID session id and always clean up in a `finally`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";

import { sessionRoot, resetSession } from "../src/runtime/session.mjs";
import { writeArtifact, sessionArtifactsDir, readArtifact } from "../src/runtime/artifacts.mjs";

function randomSessionId() {
  return crypto.randomUUID();
}

test("writeArtifact rejects an unknown kind", async () => {
  const sessionId = randomSessionId();
  await assert.rejects(
    () => writeArtifact(sessionId, { kind: "not-a-real-kind", ext: "txt", data: "hello" }),
    /unknown artifact kind/
  );
});

test("writeArtifact writes bytes under sessionRoot()/<id>/artifacts/<kind>/ with the right extension", async () => {
  const sessionId = randomSessionId();
  try {
    const meta = await writeArtifact(sessionId, { kind: "screenshot", ext: "png", data: "fake-png-bytes" });

    assert.equal(meta.kind, "screenshot");
    assert.equal(meta.bytes, Buffer.byteLength("fake-png-bytes"));
    assert.match(meta.path, /\.png$/);
    assert.ok(meta.path.startsWith(sessionArtifactsDir(sessionId)));
    assert.equal(meta.path, join(sessionArtifactsDir(sessionId), "screenshot", `${meta.hash}.png`));

    const onDisk = await readFile(meta.path, "utf8");
    assert.equal(onDisk, "fake-png-bytes");
  } finally {
    await resetSession(sessionId);
  }
});

test("writeArtifact is content-addressed — identical data dedupes to one file", async () => {
  const sessionId = randomSessionId();
  try {
    const first = await writeArtifact(sessionId, { kind: "console-log", ext: "txt", data: "same content" });
    const second = await writeArtifact(sessionId, { kind: "console-log", ext: "txt", data: "same content" });

    assert.equal(first.hash, second.hash);
    assert.equal(first.path, second.path);

    const dir = join(sessionArtifactsDir(sessionId), "console-log");
    const files = await readdir(dir);
    assert.equal(files.length, 1);
  } finally {
    await resetSession(sessionId);
  }
});

test("different kinds land in different subdirectories even with identical bytes", async () => {
  const sessionId = randomSessionId();
  try {
    const asScreenshot = await writeArtifact(sessionId, { kind: "screenshot", ext: "png", data: "identical" });
    const asDockerLog = await writeArtifact(sessionId, { kind: "docker-log", ext: "txt", data: "identical" });

    assert.notEqual(asScreenshot.path, asDockerLog.path);
    assert.ok(asScreenshot.path.includes("screenshot"));
    assert.ok(asDockerLog.path.includes("docker-log"));
  } finally {
    await resetSession(sessionId);
  }
});

test("readArtifact reads back exactly what writeArtifact wrote", async () => {
  const sessionId = randomSessionId();
  try {
    const meta = await writeArtifact(sessionId, { kind: "vision-response", ext: "txt", data: "the app renders correctly" });
    const bytes = await readArtifact(meta.path);
    assert.equal(bytes.toString("utf8"), "the app renders correctly");
  } finally {
    await resetSession(sessionId);
  }
});

test("resetSession also removes the session's artifacts directory", async () => {
  const sessionId = randomSessionId();
  await writeArtifact(sessionId, { kind: "network-log", ext: "json", data: "[]" });
  const dir = sessionArtifactsDir(sessionId);

  assert.ok((await stat(dir)).isDirectory());

  await resetSession(sessionId);

  await assert.rejects(() => stat(dir), /ENOENT/);
});

test("sessionArtifactsDir is scoped under sessionRoot()", () => {
  const sessionId = randomSessionId();
  const dir = sessionArtifactsDir(sessionId);
  assert.ok(dir.startsWith(sessionRoot()));
  assert.ok(dir.includes(sessionId));
});
