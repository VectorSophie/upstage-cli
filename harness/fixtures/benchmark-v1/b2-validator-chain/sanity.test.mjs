import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "./validate.mjs";
test("sanity_neg_is_bad", () => assert.equal(check(-1), "bad"));
