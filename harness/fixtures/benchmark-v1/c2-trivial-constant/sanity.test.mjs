import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZE } from "./config.mjs";
test("sanity_number", () => assert.equal(typeof PAGE_SIZE, "number"));
