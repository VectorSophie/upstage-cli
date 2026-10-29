import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "./inventory.mjs";
test("fix_sum", () => assert.equal(total([{ qty: 2 }, { qty: 3 }]), 5));
test("fix_empty", () => assert.equal(total([]), 0));
test("fix_single", () => assert.equal(total([{ qty: 10 }]), 10));
