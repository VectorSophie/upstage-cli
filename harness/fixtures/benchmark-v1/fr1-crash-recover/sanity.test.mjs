import { test } from "node:test";
import assert from "node:assert/strict";
import { names } from "./extract.mjs";
test("sanity_empty_list", () => assert.deepEqual(names([]), []));
