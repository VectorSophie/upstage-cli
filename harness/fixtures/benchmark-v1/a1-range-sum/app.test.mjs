import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeSum } from "./src.mjs";
test("fix_sum_1_to_5", () => assert.equal(rangeSum(5), 15));
test("fix_sum_1_to_10", () => assert.equal(rangeSum(10), 55));
test("fix_sum_1_to_1", () => assert.equal(rangeSum(1), 1));
test("fix_sum_1_to_100", () => assert.equal(rangeSum(100), 5050));
