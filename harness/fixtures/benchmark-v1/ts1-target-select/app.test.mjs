import { test } from "node:test";
import assert from "node:assert/strict";
import { maxRetries } from "./index.mjs";
test("fix_value", () => assert.equal(maxRetries(), 4));
