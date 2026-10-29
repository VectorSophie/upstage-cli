import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./pipeline.mjs";
test("fix_default_is_positive", () => assert.ok(run() > 0));
test("fix_explicit_size", () => assert.equal(run(5), 10));
test("fix_invalid_still_rejected", () => assert.throws(() => run(-1), RangeError));
