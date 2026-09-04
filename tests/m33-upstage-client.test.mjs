import test from "node:test";
import assert from "node:assert/strict";

import { upstageRequest } from "../src/upstage/client.mjs";
import { UpstageApiError } from "../src/upstage/errors.mjs";

// Matches the pattern used in tests/m7-robustness.test.mjs for exercising
// fetchWithRetry's exponential backoff without actually waiting.
function withImmediateTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => {
    callback(...args);
    return 0;
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout;
    });
}

function withMockFetch(impl, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test("upstageRequest makes a successful JSON call", async () => {
  let calls = 0;
  let seenUrl;
  let seenOptions;
  await withMockFetch(
    async (url, options) => {
      calls += 1;
      seenUrl = url;
      seenOptions = options;
      return new Response(JSON.stringify({ ok: true, value: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    async () => {
      const result = await upstageRequest({
        path: "/embeddings",
        method: "POST",
        body: { input: "hello", model: "embedding-passage" },
        apiKey: "test-key",
        baseUrl: "https://api.example.test"
      });

      assert.equal(calls, 1);
      assert.equal(seenUrl, "https://api.example.test/embeddings");
      assert.equal(seenOptions.method, "POST");
      assert.equal(seenOptions.headers.Authorization, "Bearer test-key");
      assert.equal(seenOptions.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(seenOptions.body), { input: "hello", model: "embedding-passage" });
      assert.deepEqual(result, { ok: true, value: 42 });
    }
  );
});

test("upstageRequest makes a successful multipart call", async () => {
  let calls = 0;
  let seenOptions;
  await withMockFetch(
    async (_url, options) => {
      calls += 1;
      seenOptions = options;
      return new Response(JSON.stringify({ elements: [{ content: { text: "hi" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    async () => {
      const fileBuffer = Buffer.from("fake-pdf-bytes");
      const result = await upstageRequest({
        path: "/document-digitization",
        isMultipart: true,
        formFields: { model: "document-parse", ocr: "auto" },
        fileField: { buffer: fileBuffer, filename: "test.pdf", contentType: "application/pdf" },
        apiKey: "test-key",
        baseUrl: "https://api.example.test"
      });

      assert.equal(calls, 1);
      assert.match(seenOptions.headers["Content-Type"], /^multipart\/form-data; boundary=/);

      const boundary = seenOptions.headers["Content-Type"].split("boundary=")[1];
      const bodyText = Buffer.from(seenOptions.body).toString("utf8");

      // Both form fields present with correct disposition.
      assert.match(bodyText, /Content-Disposition: form-data; name="model"\r\n\r\ndocument-parse/);
      assert.match(bodyText, /Content-Disposition: form-data; name="ocr"\r\n\r\nauto/);
      // File field present with filename + content-type, and the raw bytes are in the body.
      assert.match(
        bodyText,
        /Content-Disposition: form-data; name="document"; filename="test\.pdf"\r\nContent-Type: application\/pdf/
      );
      assert.ok(bodyText.includes("fake-pdf-bytes"));
      // Body starts and ends with the boundary markers.
      assert.ok(bodyText.startsWith(`--${boundary}\r\n`));
      assert.ok(bodyText.endsWith(`--${boundary}--\r\n`));

      assert.deepEqual(result, { elements: [{ content: { text: "hi" } }] });
    }
  );
});

test("upstageRequest retries on 429 and succeeds on the third attempt", async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("rate limited", { status: 429, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    () =>
      withImmediateTimers(async () => {
        const result = await upstageRequest({
          path: "/embeddings",
          body: { input: "x" },
          apiKey: "test-key",
          baseUrl: "https://api.example.test"
        });
        assert.equal(calls, 3);
        assert.deepEqual(result, { ok: true });
      })
  );
});

test("upstageRequest throws UpstageApiError with correct status after retries exhausted", async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "server exploded" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    },
    () =>
      withImmediateTimers(async () => {
        await assert.rejects(
          () =>
            upstageRequest({
              path: "/embeddings",
              body: { input: "x" },
              apiKey: "test-key",
              baseUrl: "https://api.example.test"
            }),
          (err) => {
            assert.ok(err instanceof UpstageApiError);
            assert.equal(err.status, 500);
            assert.equal(err.retryable, true);
            assert.deepEqual(err.body, { error: "server exploded" });
            return true;
          }
        );
        // Default fetchWithRetry: maxRetries=3 -> attempts at 0,1,2,3 = 4 total calls.
        assert.equal(calls, 4);
      })
  );
});

test("upstageRequest throws before any network call when API key is missing", async () => {
  const originalEnv = process.env.UPSTAGE_API_KEY;
  delete process.env.UPSTAGE_API_KEY;
  let calls = 0;
  try {
    await withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => upstageRequest({ path: "/embeddings", body: { input: "x" } }),
          (err) => {
            assert.ok(err instanceof UpstageApiError);
            return true;
          }
        );
        assert.equal(calls, 0, "fetch must not be called when no API key is resolvable");
      }
    );
  } finally {
    if (originalEnv === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = originalEnv;
  }
});

test("upstageRequest supports an absolute URL passed as path", async () => {
  let seenUrl;
  await withMockFetch(
    async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    async () => {
      await upstageRequest({
        path: "https://other.example.test/custom",
        body: { a: 1 },
        apiKey: "k"
      });
      assert.equal(seenUrl, "https://other.example.test/custom");
    }
  );
});

test("upstageRequest throws UpstageApiError with a non-JSON success response, without a raw SyntaxError", async () => {
  await withMockFetch(
    async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
    async () => {
      await assert.rejects(
        () =>
          upstageRequest({
            path: "/embeddings",
            body: { input: "x" },
            apiKey: "test-key",
            baseUrl: "https://api.example.test"
          }),
        (err) => {
          assert.ok(err instanceof UpstageApiError);
          assert.equal(err.status, 200);
          assert.equal(err.retryable, false);
          return true;
        }
      );
    }
  );
});

test("upstageRequest rejects a missing/empty path before any network call", async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    async () => {
      await assert.rejects(
        () => upstageRequest({ apiKey: "test-key" }),
        (err) => {
          assert.ok(err instanceof UpstageApiError);
          return true;
        }
      );
      assert.equal(calls, 0, "fetch must not be called when path is missing");
    }
  );
});

test("upstageRequest rejects a multipart request missing fileField.buffer before any network call", async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    async () => {
      await assert.rejects(
        () =>
          upstageRequest({
            path: "/document-digitization",
            isMultipart: true,
            formFields: { model: "document-parse" },
            fileField: { filename: "test.pdf", contentType: "application/pdf" },
            apiKey: "test-key"
          }),
        (err) => {
          assert.ok(err instanceof UpstageApiError);
          return true;
        }
      );
      assert.equal(calls, 0, "fetch must not be called when fileField.buffer is missing");
    }
  );
});

test("upstageRequest aborts the underlying fetch when timeoutMs elapses", async () => {
  let sawSignal = false;
  let signalWasAborted = false;
  await withMockFetch(
    (_url, options) => {
      sawSignal = options.signal instanceof AbortSignal;
      // With immediate-fake timers, setTimeout(() => controller.abort(), ms) may run
      // synchronously before fetch is even invoked, so the signal can already be
      // aborted by the time we get here — handle both orderings.
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          signalWasAborted = true;
          const abortError = new Error("This operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        };
        if (options.signal.aborted) rejectAborted();
        else options.signal.addEventListener("abort", rejectAborted);
        // Otherwise never resolves on its own — only the abort should settle this promise.
      });
    },
    () =>
      withImmediateTimers(async () => {
        await assert.rejects(
          () =>
            upstageRequest({
              path: "/embeddings",
              body: { input: "x" },
              apiKey: "test-key",
              baseUrl: "https://api.example.test",
              timeoutMs: 5
            }),
          () => true
        );
        assert.ok(sawSignal, "fetch should receive an AbortSignal");
        assert.ok(signalWasAborted, "the signal should have been aborted after timeoutMs");
      })
  );
});
