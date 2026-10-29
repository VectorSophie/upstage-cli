import { test } from "node:test";
import assert from "node:assert/strict";
import { rightAlign } from "./greet.mjs";
test("sanity_length", () => assert.equal(rightAlign("hi", 5).length, 5));
