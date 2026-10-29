import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";
test("sanity_number", () => assert.equal(typeof clamp(5, 0, 10), "number"));
