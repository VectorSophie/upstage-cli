import { test } from "node:test";
import assert from "node:assert/strict";
import { Stack } from "./stack.mjs";
test("sanity_push_returns_undefined", () => assert.equal(new Stack().push(1), undefined));
