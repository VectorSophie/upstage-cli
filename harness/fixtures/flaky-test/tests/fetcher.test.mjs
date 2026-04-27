import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchData, parseConfig } from "../fetcher.mjs";

describe("fetchData", () => {
  it("test_data_fetch — returns data array", async () => {
    // BUG: missing `await` — result is a Promise, not the resolved value
    const result = fetchData("https://example.com/api");
    assert.ok(Array.isArray(result.data), "data should be an array");
  });
});

describe("parseConfig", () => {
  it("test_config — parses valid JSON string", () => {
    const cfg = parseConfig('{"debug":true,"port":3000}');
    assert.equal(cfg.debug, true);
    assert.equal(cfg.port, 3000);
  });

  it("test_parse — throws on non-string input", () => {
    assert.throws(() => parseConfig(123), /config must be a string/);
  });
});
