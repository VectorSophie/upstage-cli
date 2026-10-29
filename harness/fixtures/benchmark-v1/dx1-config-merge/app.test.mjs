import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";
test("fix_nested_override_keeps_siblings", () => {
  const c = loadConfig({ server: { timeout: 5 } });
  assert.equal(c.server.host, "localhost");
  assert.equal(c.server.port, 8080);
  assert.equal(c.server.timeout, 5);
});
test("fix_top_level_override_keeps_server", () => {
  const c = loadConfig({ retries: 9 });
  assert.equal(c.retries, 9);
  assert.equal(c.server.port, 8080);
});
test("fix_partial_nested", () => {
  const c = loadConfig({ server: { host: "example.com" } });
  assert.equal(c.server.host, "example.com");
  assert.equal(c.server.timeout, 30);
});
