import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "../parser.mjs";

test("test_splits_on_comma", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});
test("test_trims_fields", () => {
  assert.deepEqual(parseCsvLine(" a , b , c "), ["a", "b", "c"]);
});
