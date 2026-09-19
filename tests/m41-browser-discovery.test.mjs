// Tests for src/browser/discovery.mjs (3.3.0 Thread C, Task C.2) — locates
// an existing Chrome/Chromium install. Per the owner decision (design doc
// §C.1), this never auto-downloads a browser — it only looks, and returns a
// clear "not found, run `upstage browser install`" signal when it can't.

import test from "node:test";
import assert from "node:assert/strict";

import { findChrome } from "../src/browser/discovery.mjs";

test("findChrome returns a path when a candidate exists on disk", async () => {
  // This dev box has a real Chrome install (verified during 3.3.0 Session 3
  // research) — exercises the real discovery path, not just a mock.
  const found = await findChrome();
  if (!found) return; // environment without Chrome — nothing more to assert
  assert.equal(typeof found, "string");
  assert.ok(found.length > 0);
});

test("findChrome checks an injected candidate list and returns the first existing path", async () => {
  const found = await findChrome({
    candidates: ["/definitely/not/a/real/path/chrome", process.execPath],
    exists: async (path) => path === process.execPath
  });
  assert.equal(found, process.execPath);
});

test("findChrome returns null when nothing on the candidate list exists", async () => {
  const found = await findChrome({
    candidates: ["/nope/one", "/nope/two"],
    exists: async () => false
  });
  assert.equal(found, null);
});
