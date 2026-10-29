import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "./inventory.mjs";
test("sanity_number", () => assert.equal(typeof total([]), "number"));
