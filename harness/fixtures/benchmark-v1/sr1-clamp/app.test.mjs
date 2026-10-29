import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";
test("fix_within", () => assert.equal(clamp(5, 0, 10), 5));
test("fix_below", () => assert.equal(clamp(-3, 0, 10), 0));
test("fix_above", () => assert.equal(clamp(99, 0, 10), 10));
test("fix_edge_hi", () => assert.equal(clamp(10, 0, 10), 10));
