import { test } from "node:test";
import assert from "node:assert/strict";
import { summary } from "./report.mjs";
test("sanity_total", () => assert.equal(summary([2, 4, 6]).total, 12));
