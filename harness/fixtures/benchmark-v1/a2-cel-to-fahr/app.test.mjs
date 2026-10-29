import { test } from "node:test";
import assert from "node:assert/strict";
import { cToF } from "./src.mjs";
test("fix_freezing", () => assert.equal(cToF(0), 32));
test("fix_boiling", () => assert.equal(cToF(100), 212));
