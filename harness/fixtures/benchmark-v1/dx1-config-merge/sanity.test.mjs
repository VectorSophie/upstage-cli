import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";
test("sanity_empty_keeps_defaults", () => {
  const c = loadConfig({});
  assert.equal(c.server.port, 8080);
  assert.equal(c.retries, 3);
});
