import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "./csv.mjs";
test("sanity_array", () => assert.ok(Array.isArray(parseLine("x"))));
