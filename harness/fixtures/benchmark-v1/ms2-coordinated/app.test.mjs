import { test } from "node:test";
import assert from "node:assert/strict";
import { biggestTwo } from "./run.mjs";
test("fix_dupes", () => assert.deepEqual(biggestTwo([3, 1, 2, 3, 2]), [3, 2]));
test("fix_sorted_desc", () => assert.deepEqual(biggestTwo([1, 2, 3, 4]), [4, 3]));
test("fix_single", () => assert.deepEqual(biggestTwo([7]), [7]));
test("fix_two_distinct", () => assert.deepEqual(biggestTwo([5, 5, 2]), [5, 2]));
