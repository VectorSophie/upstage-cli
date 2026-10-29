import { test } from "node:test";
import assert from "node:assert/strict";
import { add, sub } from "./math.mjs";
test("sanity_add_unchanged", () => assert.equal(add(2, 3), 5));
test("sanity_sub_unchanged", () => assert.equal(sub(5, 2), 3));
