import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "./validate.mjs";
test("fix_zero_is_bad", () => assert.equal(check(0), "bad"));
test("fix_pos_is_ok", () => assert.equal(check(5), "ok"));
