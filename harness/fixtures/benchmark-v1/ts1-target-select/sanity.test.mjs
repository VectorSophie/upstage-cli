import { test } from "node:test";
import assert from "node:assert/strict";
import { maxRetries } from "./index.mjs";
test("sanity_number", () => assert.equal(typeof maxRetries(), "number"));
