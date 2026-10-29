import { test } from "node:test";
import assert from "node:assert/strict";
import { biggestTwo } from "./run.mjs";
test("sanity_empty", () => assert.deepEqual(biggestTwo([]), []));
