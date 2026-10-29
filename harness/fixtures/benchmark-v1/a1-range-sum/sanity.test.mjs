import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeSum } from "./src.mjs";
test("sanity_zero", () => assert.equal(rangeSum(0), 0));
test("sanity_number", () => assert.equal(typeof rangeSum(3), "number"));
