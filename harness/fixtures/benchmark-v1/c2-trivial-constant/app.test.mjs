import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZE } from "./config.mjs";
test("fix_page_size", () => assert.equal(PAGE_SIZE, 10));
