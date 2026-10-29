import { test } from "node:test";
import assert from "node:assert/strict";
import { mul } from "./math.mjs";
test("fix_mul", () => assert.equal(mul(3, 4), 12));
