import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slug.mjs";
test("fix_slug", () => assert.equal(slugify("Hello World"), "hello-world"));
test("fix_slug_trim", () => assert.equal(slugify("  A  B  "), "a-b"));
