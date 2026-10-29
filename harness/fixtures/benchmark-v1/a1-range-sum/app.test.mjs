import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeSum } from "./src.mjs";
test("fix_sum_1_to_5", () => assert.equal(rangeSum(5), 15));
test("fix_sum_1_to_10", () => assert.equal(rangeSum(10), 55));
