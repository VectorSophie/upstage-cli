import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./pipeline.mjs";
test("sanity_valid_explicit", () => assert.equal(run(3), 6));
