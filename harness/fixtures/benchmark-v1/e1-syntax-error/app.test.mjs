import { test } from "node:test";
import assert from "node:assert/strict";
import { doubleIt } from "./broken.mjs";
test("fix_double", () => assert.equal(doubleIt(4), 8));
