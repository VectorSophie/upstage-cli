import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyDocument, MIN_CATEGORIES, MAX_CATEGORIES } from "../src/upstage/classification.mjs";

// This repo has no ESM module-mocking available without an experimental Node
// flag (verified in tests/m33-upstage-client.test.mjs / m33-upstage-documents.test.mjs),
// so — matching the established pattern — these tests mock global.fetch, the
// actual network boundary underneath upstageRequest, rather than
// upstageRequest or classifyDocument() themselves.
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "upstage-classification-test-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name, bytes = Buffer.from("fake-file-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

// Best-effort per plan §3: confidence arrives via a synthetic tool-call
// shape, tool_calls[0].function.arguments.document_type.confidence_score.
const REALISTIC_RESPONSE = {
  tool_calls: [
    {
      function: {
        arguments: JSON.stringify({ document_type: { label: "invoice", confidence_score: 0.87 } })
      }
    }
  ]
};

test("classifyDocument sends model=document-classify and the file, and parses label/confidence", async () => {
  const path = fixture("doc.pdf");
  let seenUrl;
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (url, options) => {
        seenUrl = url;
        seenOptions = options;
        return jsonResponse(REALISTIC_RESPONSE);
      },
      async () => {
        const result = await classifyDocument({ path, categories: ["invoice", "contract", "receipt"] });

        assert.match(seenUrl, /\/document-classification$/);
        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="model"\r\n\r\ndocument-classify/);
        assert.match(bodyText, /name="document"; filename="doc\.pdf"\r\nContent-Type: application\/pdf/);

        assert.deepEqual(result, { label: "invoice", confidence: 0.87 });
      }
    )
  );
});

test("classifyDocument builds a oneOf/const JSON schema from the categories array", async () => {
  const path = fixture("doc2.pdf");
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return jsonResponse(REALISTIC_RESPONSE);
      },
      async () => {
        await classifyDocument({ path, categories: ["invoice", "contract", "receipt"] });

        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        const match = bodyText.match(/name="response_format"\r\n\r\n([\s\S]*?)\r\n--/);
        assert.ok(match, "response_format field should be present in the multipart body");

        const responseFormat = JSON.parse(match[1]);
        assert.equal(responseFormat.type, "json_schema");
        assert.equal(responseFormat.json_schema.name, "document_type");
        assert.deepEqual(responseFormat.json_schema.schema.properties.document_type.oneOf, [
          { const: "invoice" },
          { const: "contract" },
          { const: "receipt" }
        ]);
        assert.equal(responseFormat.json_schema.schema.properties.document_type.type, "string");
      }
    )
  );
});

test("classifyDocument parses a response where document_type is a bare string label with no confidence", async () => {
  const path = fixture("doc3.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        jsonResponse({
          tool_calls: [{ function: { arguments: JSON.stringify({ document_type: "contract" }) } }]
        }),
      async () => {
        const result = await classifyDocument({ path, categories: ["invoice", "contract"] });
        assert.equal(result.label, "contract");
        assert.equal(result.confidence, undefined);
      }
    )
  );
});

test("classifyDocument parses arguments given as an already-parsed object (not a JSON string)", async () => {
  const path = fixture("doc4.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        jsonResponse({
          tool_calls: [
            { function: { arguments: { document_type: { value: "receipt", confidence_score: 0.5 } } } }
          ]
        }),
      async () => {
        const result = await classifyDocument({ path, categories: ["invoice", "receipt"] });
        assert.deepEqual(result, { label: "receipt", confidence: 0.5 });
      }
    )
  );
});

test("classifyDocument throws on an unexpected response shape", async () => {
  const path = fixture("doc5.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () => jsonResponse({ unexpected: true }),
      async () => {
        await assert.rejects(
          () => classifyDocument({ path, categories: ["invoice", "contract"] }),
          /unexpected response shape/
        );
      }
    )
  );
});

test("classifyDocument rejects an empty or single-item categories list before any network call", async () => {
  const path = fixture("doc6.pdf");
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse(REALISTIC_RESPONSE);
      },
      async () => {
        await assert.rejects(() => classifyDocument({ path, categories: [] }), /at least 2 categories/);
        await assert.rejects(() => classifyDocument({ path, categories: ["invoice"] }), /at least 2 categories/);
        await assert.rejects(() => classifyDocument({ path }), /requires a `categories` array/);
        assert.equal(calls, 0, "invalid categories must fail before any fetch call");
      }
    )
  );
});

test("classifyDocument rejects non-string/empty-string category entries before any network call", async () => {
  const path = fixture("doc6b.pdf");
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse(REALISTIC_RESPONSE);
      },
      async () => {
        await assert.rejects(() => classifyDocument({ path, categories: ["invoice", 123] }), /non-empty string/);
        await assert.rejects(() => classifyDocument({ path, categories: ["invoice", ""] }), /non-empty string/);
        await assert.rejects(() => classifyDocument({ path, categories: ["invoice", "   "] }), /non-empty string/);
        await assert.rejects(() => classifyDocument({ path, categories: ["invoice", null] }), /non-empty string/);
        assert.equal(calls, 0, "invalid category entries must fail before any fetch call");
      }
    )
  );
});

test("classifyDocument rejects a categories list over 1,000 entries before any network call", async () => {
  const path = fixture("doc7.pdf");
  let calls = 0;
  const tooMany = Array.from({ length: MAX_CATEGORIES + 1 }, (_, i) => `category-${i}`);
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse(REALISTIC_RESPONSE);
      },
      async () => {
        await assert.rejects(() => classifyDocument({ path, categories: tooMany }), /at most 1000 categories/);
        assert.equal(calls, 0, "over-cap categories must fail before any fetch call");
      }
    )
  );
});

test("classifyDocument accepts exactly MIN_CATEGORIES and exactly MAX_CATEGORIES", async () => {
  const path = fixture("doc8.pdf");
  const exactlyMax = Array.from({ length: MAX_CATEGORIES }, (_, i) => `category-${i}`);
  await withApiKey(() =>
    withMockFetch(
      async () => jsonResponse(REALISTIC_RESPONSE),
      async () => {
        await classifyDocument({ path, categories: ["a", "b"].slice(0, MIN_CATEGORIES) });
        await classifyDocument({ path, categories: exactlyMax });
      }
    )
  );
});

test("classifyDocument rejects a missing file before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse(REALISTIC_RESPONSE);
      },
      async () => {
        await assert.rejects(
          () => classifyDocument({ path: join(dir, "does-not-exist.pdf"), categories: ["a", "b"] }),
          /File not found/
        );
        assert.equal(calls, 0);
      }
    )
  );
});
