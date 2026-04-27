# flaky-test fixture

## Bug

`tests/fetcher.test.mjs::test_data_fetch` is missing `await` before `fetchData(...)`.
The test receives a `Promise` object instead of the resolved value, so `result.data`
is `undefined` and `Array.isArray(undefined)` is `false` — the assertion always fails.

## Expected Fix

Add `await` to the `fetchData` call.

### file: tests/fetcher.test.mjs
```
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchData, parseConfig } from "../fetcher.mjs";

describe("fetchData", () => {
  it("test_data_fetch — returns data array", async () => {
    const result = await fetchData("https://example.com/api");
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
```

## Test Split

- **fail_to_pass**: `node --test tests/fetcher.test.mjs --test-name-pattern "test_data_fetch"`
- **pass_to_pass**: `node --test tests/fetcher.test.mjs --test-name-pattern "test_config|test_parse"`
