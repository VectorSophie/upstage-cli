import { test } from "node:test";
import assert from "node:assert/strict";
import { summary } from "./report.mjs";
test("fix_avg_three", () => assert.equal(summary([2, 4, 6]).average, 4));
test("fix_avg_single", () => assert.equal(summary([10]).average, 10));
test("fix_avg_four", () => assert.equal(summary([1, 2, 3, 4]).average, 2.5));
