import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "./router.mjs";
test("sanity_exact_match", () => assert.equal(route("/users"), "USERS"));
