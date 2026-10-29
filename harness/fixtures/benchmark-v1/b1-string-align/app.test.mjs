import { test } from "node:test";
import assert from "node:assert/strict";
import { rightAlign } from "./greet.mjs";
test("fix_align", () => assert.equal(rightAlign("hi", 5), "   hi"));
