import { test } from "node:test";
import assert from "node:assert/strict";
import { cToF } from "./src.mjs";
test("sanity_number", () => assert.equal(typeof cToF(0), "number"));
