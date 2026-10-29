import { test } from "node:test";
import assert from "node:assert/strict";
import { Stack } from "./stack.mjs";
test("fix_lifo", () => {
  const s = new Stack();
  s.push(1); s.push(2);
  assert.equal(s.pop(), 2);
  assert.equal(s.pop(), 1);
});
test("fix_size", () => {
  const s = new Stack();
  s.push(10);
  assert.equal(s.size(), 1);
});
