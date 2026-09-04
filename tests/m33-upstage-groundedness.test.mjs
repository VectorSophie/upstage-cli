import test from "node:test";
import assert from "node:assert/strict";

import { checkGroundedness } from "../src/upstage/groundedness.mjs";

// checkGroundedness() calls UpstageAdapter directly (a chat-completions
// call, not a multipart/JSON upstageRequest() call — see groundedness.mjs's
// header for why), so — matching the pattern of m15-providers-streaming and
// the other m33-upstage-*.test.mjs files — these tests mock global.fetch,
// the actual network boundary underneath UpstageAdapter.complete().
function withMockFetch(impl, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function withApiKey(run) {
  const original = process.env.UPSTAGE_API_KEY;
  process.env.UPSTAGE_API_KEY = "test-key";
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (original === undefined) delete process.env.UPSTAGE_API_KEY;
      else process.env.UPSTAGE_API_KEY = original;
    });
}

function withEnvGroundednessModel(value, run) {
  const original = process.env.UPSTAGE_GROUNDEDNESS_MODEL;
  if (value === undefined) delete process.env.UPSTAGE_GROUNDEDNESS_MODEL;
  else process.env.UPSTAGE_GROUNDEDNESS_MODEL = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (original === undefined) delete process.env.UPSTAGE_GROUNDEDNESS_MODEL;
      else process.env.UPSTAGE_GROUNDEDNESS_MODEL = original;
    });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function chatResponse(content) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

test("checkGroundedness sends context as user message, answer as assistant message, non-streaming", async () => {
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return chatResponse("grounded");
      },
      async () => {
        await checkGroundedness({ context: "The sky is blue.", answer: "The sky is blue." });

        const body = JSON.parse(seenOptions.body);
        assert.deepEqual(body.messages, [
          { role: "user", content: "The sky is blue." },
          { role: "assistant", content: "The sky is blue." }
        ]);
        assert.equal(body.stream, false);
      }
    )
  );
});

test("checkGroundedness defaults to model id groundedness-check", async () => {
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return chatResponse("grounded");
      },
      async () => {
        await checkGroundedness({ context: "ctx", answer: "ans" });
        const body = JSON.parse(seenOptions.body);
        assert.equal(body.model, "groundedness-check");
      }
    )
  );
});

test("checkGroundedness honors UPSTAGE_GROUNDEDNESS_MODEL override", async () => {
  let seenOptions;
  await withApiKey(() =>
    withEnvGroundednessModel("custom-groundedness-model", () =>
      withMockFetch(
        async (_url, options) => {
          seenOptions = options;
          return chatResponse("grounded");
        },
        async () => {
          await checkGroundedness({ context: "ctx", answer: "ans" });
          const body = JSON.parse(seenOptions.body);
          assert.equal(body.model, "custom-groundedness-model");
        }
      )
    )
  );
});

test("checkGroundedness parses a 'grounded' response", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("grounded"),
      async () => {
        const result = await checkGroundedness({ context: "ctx", answer: "ans" });
        assert.deepEqual(result, { grounded: "grounded", raw: "grounded" });
      }
    )
  );
});

test("checkGroundedness parses a 'notGrounded' response", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("notGrounded"),
      async () => {
        const result = await checkGroundedness({ context: "ctx", answer: "ans" });
        assert.deepEqual(result, { grounded: "notGrounded", raw: "notGrounded" });
      }
    )
  );
});

test("checkGroundedness parses a 'notSure' response", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("notSure"),
      async () => {
        const result = await checkGroundedness({ context: "ctx", answer: "ans" });
        assert.deepEqual(result, { grounded: "notSure", raw: "notSure" });
      }
    )
  );
});

test("checkGroundedness treats an unrecognized response as notSure and still returns raw", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("unexpected garbage"),
      async () => {
        const result = await checkGroundedness({ context: "ctx", answer: "ans" });
        assert.deepEqual(result, { grounded: "notSure", raw: "unexpected garbage" });
      }
    )
  );
});

test("checkGroundedness is whitespace/case tolerant when parsing labels", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("  Not Grounded  "),
      async () => {
        const result = await checkGroundedness({ context: "ctx", answer: "ans" });
        assert.equal(result.grounded, "notGrounded");
      }
    )
  );
});

test("checkGroundedness rejects a missing context or answer before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return chatResponse("grounded");
      },
      async () => {
        await assert.rejects(() => checkGroundedness({ context: "", answer: "ans" }), /requires a `context`/);
        await assert.rejects(() => checkGroundedness({ context: "ctx", answer: "" }), /requires an `answer`/);
        await assert.rejects(() => checkGroundedness({}), /requires a `context`/);
        assert.equal(calls, 0, "missing context/answer must fail before any fetch call");
      }
    )
  );
});

test("checkGroundedness throws when UPSTAGE_API_KEY is not configured", async () => {
  const original = process.env.UPSTAGE_API_KEY;
  delete process.env.UPSTAGE_API_KEY;
  try {
    await assert.rejects(
      () => checkGroundedness({ context: "ctx", answer: "ans" }),
      /UPSTAGE_API_KEY is not configured/
    );
  } finally {
    if (original === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = original;
  }
});
