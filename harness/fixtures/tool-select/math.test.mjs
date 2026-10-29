import { test } from "node:test";
import assert from "node:assert/strict";
import { add, mul } from "./math.mjs";

test("test_add", () => { assert.equal(add(2, 3), 5); });
test("test_mul", () => { assert.equal(mul(4, 5), 20); });
