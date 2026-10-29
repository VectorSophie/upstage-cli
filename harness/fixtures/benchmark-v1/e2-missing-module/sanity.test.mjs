import { test } from "node:test";
import assert from "node:assert/strict";
test("sanity_env", () => assert.equal(typeof "x", "string"));
