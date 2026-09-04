import test from "node:test";
import assert from "node:assert/strict";

import { embed } from "../src/upstage/embeddings.mjs";
import { semanticSearchTool } from "../src/tools/builtin/semantic-search.mjs";
import { UpstageEmbeddingProvider } from "../src/retriever/providers/upstage.mjs";

// This repo has no ESM module-mocking available without an experimental Node
// flag (verified in tests/m33-upstage-client.test.mjs / m33-upstage-documents.test.mjs),
// so — matching the established pattern — these tests mock global.fetch, the
// actual network boundary underneath upstageRequest, rather than
// upstageRequest or embed() themselves.
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

function withEmbeddingModelOverride(value, run) {
  const original = process.env.UPSTAGE_EMBEDDING_MODEL;
  if (value === undefined) delete process.env.UPSTAGE_EMBEDDING_MODEL;
  else process.env.UPSTAGE_EMBEDDING_MODEL = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (original === undefined) delete process.env.UPSTAGE_EMBEDDING_MODEL;
      else process.env.UPSTAGE_EMBEDDING_MODEL = original;
    });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const FAKE_EMBEDDING_RESPONSE = (n) => ({
  data: Array.from({ length: n }, (_, i) => ({ embedding: [i, i + 0.5, i + 1] }))
});

test("embed() requests solar-embedding-2-query for type 'query' (default)", async () => {
  let seenBody;
  await withApiKey(() =>
    withEmbeddingModelOverride(undefined, () =>
      withMockFetch(
        async (_url, options) => {
          seenBody = JSON.parse(options.body);
          return jsonResponse(FAKE_EMBEDDING_RESPONSE(1));
        },
        async () => {
          const vectors = await embed({ texts: ["hello"] });
          assert.equal(seenBody.model, "solar-embedding-2-query");
          assert.deepEqual(seenBody.input, ["hello"]);
          assert.deepEqual(vectors, [[0, 0.5, 1]]);
        }
      )
    )
  );
});

test("embed() requests solar-embedding-2-passage for type 'passage'", async () => {
  let seenBody, seenUrl;
  await withApiKey(() =>
    withEmbeddingModelOverride(undefined, () =>
      withMockFetch(
        async (url, options) => {
          seenUrl = url;
          seenBody = JSON.parse(options.body);
          return jsonResponse(FAKE_EMBEDDING_RESPONSE(2));
        },
        async () => {
          const vectors = await embed({ texts: ["a", "b"], type: "passage" });
          assert.match(seenUrl, /\/embeddings$/);
          assert.equal(seenBody.model, "solar-embedding-2-passage");
          assert.deepEqual(seenBody.input, ["a", "b"]);
          assert.equal(vectors.length, 2);
        }
      )
    )
  );
});

test("embed() extracts vectors from data[].embedding, preserving order", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () =>
        jsonResponse({
          data: [{ embedding: [1, 2] }, { embedding: [3, 4] }, { embedding: [5, 6] }]
        }),
      async () => {
        const vectors = await embed({ texts: ["x", "y", "z"], type: "passage" });
        assert.deepEqual(vectors, [[1, 2], [3, 4], [5, 6]]);
      }
    )
  );
});

test("embed() honors UPSTAGE_EMBEDDING_MODEL as a base name, suffixing -query/-passage", async () => {
  let seenModels = [];
  await withApiKey(() =>
    withEmbeddingModelOverride("custom-embed-gen3", () =>
      withMockFetch(
        async (_url, options) => {
          seenModels.push(JSON.parse(options.body).model);
          return jsonResponse(FAKE_EMBEDDING_RESPONSE(1));
        },
        async () => {
          await embed({ texts: ["q"], type: "query" });
          await embed({ texts: ["p"], type: "passage" });
          assert.deepEqual(seenModels, ["custom-embed-gen3-query", "custom-embed-gen3-passage"]);
        }
      )
    )
  );
});

test("embed() rejects an empty texts array before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse({ data: [] });
      },
      async () => {
        await assert.rejects(() => embed({ texts: [] }), /non-empty/);
        await assert.rejects(() => embed({}), /non-empty/);
        assert.equal(calls, 0);
      }
    )
  );
});

// --- Regression test: the actual bug this task fixes -----------------------
//
// Before this task, semantic-search.mjs and retriever/providers/upstage.mjs
// each hand-rolled their own HTTP client with their own, disagreeing default
// model name (solar-embedding-1-large vs. the non-existent bare
// "embedding-query"/"embedding-passage", read from two different env vars).
// Both callers now share src/upstage/embeddings.mjs, so they must request
// the *same* model name for the same type. This test drives each caller
// through its real public entry point (the semantic_search tool, and
// UpstageEmbeddingProvider.embedBatch) and asserts the model names on the
// wire match.
test("regression: semantic-search.mjs and the retriever provider request the same model for the same type", async () => {
  const seenModelsByType = { query: new Set(), passage: new Set() };

  await withApiKey(() =>
    withEmbeddingModelOverride(undefined, () =>
      withMockFetch(
        async (_url, options) => {
          const body = JSON.parse(options.body);
          const type = body.model.endsWith("-passage") ? "passage" : "query";
          seenModelsByType[type].add(body.model);
          return jsonResponse(FAKE_EMBEDDING_RESPONSE(Array.isArray(body.input) ? body.input.length : 1));
        },
        async () => {
          // Caller 1: the semantic_search tool (embeds a query + candidates).
          await semanticSearchTool.execute({ query: "find the payment charge function", candidates: ["a", "b"] });

          // Caller 2: the retriever's UpstageEmbeddingProvider (embeds a
          // query, then passage/document text), same as src/retriever/index.mjs does.
          const provider = new UpstageEmbeddingProvider();
          await provider.embedBatch(["some query text"], "query");
          await provider.embedBatch(["some passage text"], "passage");

          assert.equal(seenModelsByType.query.size, 1, "both callers must request the same query model");
          assert.equal(seenModelsByType.passage.size, 1, "both callers must request the same passage model");
          assert.deepEqual([...seenModelsByType.query], ["solar-embedding-2-query"]);
          assert.deepEqual([...seenModelsByType.passage], ["solar-embedding-2-passage"]);
        }
      )
    )
  );
});
