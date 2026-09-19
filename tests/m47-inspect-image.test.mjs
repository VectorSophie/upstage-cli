// Tests for src/tools/builtin/inspect-image.mjs (3.3.0 Thread D, Task D.3)
// — the optional, non-blocking vision sidecar. Per the owner decision
// (design doc §D): registered only when a usable image-capable adapter is
// configured; no key → the tool is simply absent from the registry, never
// present-but-erroring. No real Gemini API call in any test.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectImageTool, isVisionSidecarConfigured } from "../src/tools/builtin/inspect-image.mjs";
import { createRegistry } from "../src/tools/create-registry.mjs";
import { DEFAULT_POLICY } from "../src/config/defaults.mjs";
import { readArtifact } from "../src/runtime/artifacts.mjs";
import { resetSession } from "../src/runtime/session.mjs";

function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("isVisionSidecarConfigured is false with neither key set", () => {
  return withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () => {
    assert.equal(isVisionSidecarConfigured(), false);
  });
});

test("isVisionSidecarConfigured is true with GEMINI_API_KEY set", () => {
  return withEnv({ GEMINI_API_KEY: "fake-key", GOOGLE_API_KEY: undefined }, () => {
    assert.equal(isVisionSidecarConfigured(), true);
  });
});

test("inspect_image is registered when a key is configured", () => {
  return withEnv({ GEMINI_API_KEY: "fake-key" }, () => {
    const registry = createRegistry({ ...DEFAULT_POLICY });
    assert.ok(registry.list().some((t) => t.name === "inspect_image"));
  });
});

test("inspect_image is absent (not present-but-erroring) when no key is configured", () => {
  return withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () => {
    const registry = createRegistry({ ...DEFAULT_POLICY });
    assert.ok(!registry.list().some((t) => t.name === "inspect_image"));
  });
});

test("inspect_image resolves an evidence-store artifact path via a mocked adapter and writes a vision-response artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m47-inspect-image-"));
  const sessionId = crypto.randomUUID();
  try {
    const imagePath = join(dir, "screenshot.png");
    writeFileSync(imagePath, Buffer.from("fake-png-bytes"));

    const fakeAdapter = { complete: async () => ({ content: "the counter shows 1", toolCalls: [], usage: {} }) };
    const result = await inspectImageTool.execute(
      { path: imagePath, question: "what does the counter show?" },
      { session: { id: sessionId }, __adapterOverride: fakeAdapter }
    );

    assert.equal(result.answer, "the counter shows 1");
    assert.ok(result.artifact);
    assert.equal(result.artifact.kind, "vision-response");
    const bytes = await readArtifact(result.artifact.path);
    assert.equal(bytes.toString("utf8"), "the counter shows 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await resetSession(sessionId);
  }
});
