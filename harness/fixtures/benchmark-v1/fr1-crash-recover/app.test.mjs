import { test } from "node:test";
import assert from "node:assert/strict";
import { names } from "./extract.mjs";
import { RECORDS } from "./records.mjs";
test("fix_mixed", () => assert.deepEqual(names(RECORDS), ["Ann", "anonymous", "Bo"]));
test("fix_empty_record", () => assert.deepEqual(names([{}]), ["anonymous"]));
test("fix_present", () => assert.deepEqual(names([{ user: { name: "X" } }]), ["X"]));
