import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "./csv.mjs";
test("fix_fields", () => assert.deepEqual(parseLine("a, b ,c"), ["a", "b", "c"]));
