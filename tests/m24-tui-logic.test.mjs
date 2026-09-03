import { test } from "node:test";
import assert from "node:assert/strict";
import { getAutocomplete, applyCompletion } from "../src/ui/composer-autocomplete.mjs";
import { InputHistory } from "../src/ui/input-history.mjs";
import { nextMode, CYCLE_MODES } from "../src/ui/mode-cycle.mjs";
import { StreamBatcher } from "../src/ui/stream-batcher.mjs";

// ── autocomplete ────────────────────────────────────────────────────────────

const COMMANDS = [{ name: "/rewind" }, { name: "/compact" }, { name: "/cost" }, { name: "/clear" }];

test("slash autocomplete ranks prefix matches", () => {
  const ac = getAutocomplete("/c", { commands: COMMANDS });
  assert.equal(ac.mode, "command");
  assert.deepEqual(ac.items.map((c) => c.name), ["/compact", "/cost", "/clear"]);
});

test("slash autocomplete disengages after a space", () => {
  assert.equal(getAutocomplete("/rewind last", { commands: COMMANDS }), null);
});

test("@file autocomplete matches the last token and reports the replace span", () => {
  const files = ["src/agent/loop.mjs", "src/ui/App.mjs", "README.md"];
  const ac = getAutocomplete("explain @src/a", { files });
  assert.equal(ac.mode, "file");
  assert.equal(ac.items[0], "src/agent/loop.mjs");
  assert.equal(ac.start, "explain ".length);
  assert.equal(applyCompletion("explain @src/a", { mode: "file", value: ac.items[0], start: ac.start }), "explain @src/agent/loop.mjs ");
});

// ── input history ─────────────────────────────────────────────────────────

test("history navigates prev/next and skips consecutive dups", () => {
  const h = new InputHistory();
  h.push("one"); h.push("two"); h.push("two");
  assert.equal(h.prev(), "two");
  assert.equal(h.prev(), "one");
  assert.equal(h.prev(), "one"); // clamped at start
  assert.equal(h.next(), "two");
  assert.equal(h.next(), ""); // past the newest
});

// ── mode cycle ──────────────────────────────────────────────────────────────

test("mode cycle rotates default → acceptEdits → plan → default", () => {
  assert.deepEqual(CYCLE_MODES, ["default", "acceptEdits", "plan"]);
  assert.equal(nextMode("default"), "acceptEdits");
  assert.equal(nextMode("acceptEdits"), "plan");
  assert.equal(nextMode("plan"), "default");
  assert.equal(nextMode("weird"), "default");
});

// ── stream batcher ──────────────────────────────────────────────────────────

test("batcher coalesces tokens into a single manual flush", () => {
  const chunks = [];
  const b = new StreamBatcher((c) => chunks.push(c), { intervalMs: 1000 });
  b.push("Hel"); b.push("lo, "); b.push("world");
  assert.equal(chunks.length, 0); // nothing flushed yet
  b.flush();
  assert.deepEqual(chunks, ["Hello, world"]);
  b.flush(); // empty → no-op
  assert.equal(chunks.length, 1);
});

test("batcher auto-flushes on its timer", async () => {
  const chunks = [];
  const b = new StreamBatcher((c) => chunks.push(c), { intervalMs: 10 });
  b.push("x");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(chunks, ["x"]);
});
