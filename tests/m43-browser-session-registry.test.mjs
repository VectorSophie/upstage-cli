// Tests for src/browser/session-registry.mjs (3.3.0 Thread C) — keeps one
// CDPClient alive per agent session across the several browser_* tool calls
// a verification flow makes (open → snapshot → click → console →
// screenshot → close), since each tool call is a fresh execute() with no
// object to hand state through except this registry.

import test from "node:test";
import assert from "node:assert/strict";

import { getBrowser, setBrowser, closeBrowser } from "../src/browser/session-registry.mjs";

test("getBrowser returns null for a session with no open browser", () => {
  assert.equal(getBrowser("no-such-session"), null);
});

test("setBrowser then getBrowser round-trips the same instance", () => {
  const fake = { closed: false, close: async () => { fake.closed = true; } };
  setBrowser("sess-1", fake);
  assert.equal(getBrowser("sess-1"), fake);
});

test("closeBrowser tears down and removes the entry", async () => {
  const fake = { closed: false, close: async () => { fake.closed = true; } };
  setBrowser("sess-2", fake);
  await closeBrowser("sess-2");
  assert.equal(fake.closed, true);
  assert.equal(getBrowser("sess-2"), null);
});

test("closeBrowser on a session with nothing open is a no-op", async () => {
  await assert.doesNotReject(() => closeBrowser("never-opened"));
});
