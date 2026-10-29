import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "./router.mjs";
test("fix_trailing_slash", () => assert.equal(route("/users/"), "USERS"));
test("fix_case_and_slash", () => assert.equal(route("/Users/"), "USERS"));
test("fix_other_route_slash", () => assert.equal(route("/health/"), "OK"));
test("fix_unknown_stays_unknown", () => assert.equal(route("/nope"), "not found"));
