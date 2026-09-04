import test from "node:test";
import assert from "node:assert/strict";

import { checkGroundednessTool } from "../src/tools/builtin/check-groundedness.mjs";

// check_groundedness had zero test coverage before this file (see the
// 3.2.0 release plan, §2/§4/Task 7.6). Matching the established pattern in
// tests/m33-read-document.test.mjs (no ESM module-mocking available on this
// project's plain `node --test` invocation), these tests exercise the tool
// through its real dependency (src/upstage/groundedness.mjs's
// checkGroundedness) with global.fetch mocked underneath it. This verifies
// exactly what's asked: that the tool's execute() correctly adapts
// checkGroundedness()'s {grounded, raw} result into its own external
// contract, plus its own input validation, without re-testing
// groundedness.mjs's request-building/label-parsing internals (covered by
// tests/m33-upstage-groundedness.test.mjs).
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

function chatResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("check_groundedness tool metadata: name, risk, actionClass, required inputs", () => {
  assert.equal(checkGroundednessTool.name, "check_groundedness");
  assert.equal(checkGroundednessTool.risk, "low");
  assert.equal(checkGroundednessTool.actionClass, "network");
  assert.deepEqual(checkGroundednessTool.inputSchema.required, ["context", "answer"]);
});

test("check_groundedness returns {grounded, raw} for a grounded answer", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("grounded"),
      async () => {
        const result = await checkGroundednessTool.execute({
          context: "The sky is blue.",
          answer: "The sky is blue."
        });
        assert.deepEqual(result, { grounded: "grounded", raw: "grounded" });
      }
    )
  );
});

test("check_groundedness returns {grounded, raw} for a notGrounded answer", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("notGrounded"),
      async () => {
        const result = await checkGroundednessTool.execute({
          context: "The sky is blue.",
          answer: "The grass is purple."
        });
        assert.deepEqual(result, { grounded: "notGrounded", raw: "notGrounded" });
      }
    )
  );
});

test("check_groundedness returns {grounded, raw} for a notSure answer", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => chatResponse("notSure"),
      async () => {
        const result = await checkGroundednessTool.execute({
          context: "Some ambiguous context.",
          answer: "A partially supported claim."
        });
        assert.deepEqual(result, { grounded: "notSure", raw: "notSure" });
      }
    )
  );
});

test("check_groundedness sends the request as [user: context, assistant: answer], non-streaming", async () => {
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return chatResponse("grounded");
      },
      async () => {
        await checkGroundednessTool.execute({ context: "ctx text", answer: "ans text" });
        const body = JSON.parse(seenOptions.body);
        assert.deepEqual(body.messages, [
          { role: "user", content: "ctx text" },
          { role: "assistant", content: "ans text" }
        ]);
        assert.equal(body.stream, false);
      }
    )
  );
});

test("check_groundedness trims whitespace-only context/answer and rejects them, without calling fetch", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return chatResponse("grounded");
      },
      async () => {
        await assert.rejects(
          () => checkGroundednessTool.execute({ context: "   ", answer: "ans" }),
          /context is required/
        );
        await assert.rejects(
          () => checkGroundednessTool.execute({ context: "ctx", answer: "   " }),
          /answer is required/
        );
        await assert.rejects(() => checkGroundednessTool.execute({}), /context is required/);
        assert.equal(calls, 0, "missing/blank context or answer must fail before any fetch call");
      }
    )
  );
});

test("check_groundedness surfaces a missing API key as an error, without calling fetch", async () => {
  const original = process.env.UPSTAGE_API_KEY;
  delete process.env.UPSTAGE_API_KEY;
  let calls = 0;
  try {
    await withMockFetch(
      async () => {
        calls += 1;
        return chatResponse("grounded");
      },
      async () => {
        await assert.rejects(
          () => checkGroundednessTool.execute({ context: "ctx", answer: "ans" }),
          /UPSTAGE_API_KEY is not configured/
        );
        assert.equal(calls, 0);
      }
    );
  } finally {
    if (original === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = original;
  }
});
