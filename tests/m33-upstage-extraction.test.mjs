import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractStructured, generateSchema, MAX_SCHEMA_SAMPLE_PATHS } from "../src/upstage/extraction.mjs";

// Matches the established pattern (tests/m33-upstage-classification.test.mjs
// et al.): no ESM module-mocking available without an experimental Node
// flag, so mock global.fetch, the actual network boundary underneath
// upstageRequest.
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
  dir = mkdtempSync(join(tmpdir(), "upstage-extraction-test-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name, bytes = Buffer.from("fake-file-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const SAMPLE_SCHEMA = {
  title: "invoice_schema",
  type: "object",
  properties: {
    total: { type: "number" },
    vendor: { type: "string" }
  }
};

// Best-effort per plan §3, mirroring classification.mjs's REALISTIC_RESPONSE
// shape: a synthetic tool-call carrying the extracted fields as arguments.
const REALISTIC_EXTRACTION_RESPONSE = {
  tool_calls: [
    {
      function: {
        arguments: JSON.stringify({ total: 42.5, vendor: "Acme" })
      }
    }
  ]
};

test("extractStructured sends model=information-extract, the file, and a response_format built from the schema", async () => {
  const path = fixture("invoice.pdf");
  let seenUrl;
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (url, options) => {
        seenUrl = url;
        seenOptions = options;
        return jsonResponse(REALISTIC_EXTRACTION_RESPONSE);
      },
      async () => {
        const result = await extractStructured({ path, schema: SAMPLE_SCHEMA });

        assert.match(seenUrl, /\/information-extraction$/);
        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="model"\r\n\r\ninformation-extract/);
        assert.match(bodyText, /name="document"; filename="invoice\.pdf"\r\nContent-Type: application\/pdf/);

        const match = bodyText.match(/name="response_format"\r\n\r\n([\s\S]*?)\r\n--/);
        assert.ok(match, "response_format field should be present in the multipart body");
        const responseFormat = JSON.parse(match[1]);
        assert.equal(responseFormat.type, "json_schema");
        assert.equal(responseFormat.json_schema.name, "invoice_schema");
        assert.deepEqual(responseFormat.json_schema.schema, SAMPLE_SCHEMA);

        assert.deepEqual(result, { total: 42.5, vendor: "Acme" });
      }
    )
  );
});

test("extractStructured falls back to a generic response_format name when schema has no title", async () => {
  const path = fixture("invoice2.pdf");
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return jsonResponse(REALISTIC_EXTRACTION_RESPONSE);
      },
      async () => {
        await extractStructured({ path, schema: { type: "object", properties: {} } });
        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        const match = bodyText.match(/name="response_format"\r\n\r\n([\s\S]*?)\r\n--/);
        const responseFormat = JSON.parse(match[1]);
        assert.equal(responseFormat.json_schema.name, "extraction_schema");
      }
    )
  );
});

test("extractStructured parses arguments given as an already-parsed object (not a JSON string)", async () => {
  const path = fixture("invoice3.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        jsonResponse({
          tool_calls: [{ function: { arguments: { total: 10, vendor: "Beta" } } }]
        }),
      async () => {
        const result = await extractStructured({ path, schema: SAMPLE_SCHEMA });
        assert.deepEqual(result, { total: 10, vendor: "Beta" });
      }
    )
  );
});

test("extractStructured throws on an unexpected response shape", async () => {
  const path = fixture("invoice4.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () => jsonResponse({ unexpected: true }),
      async () => {
        await assert.rejects(
          () => extractStructured({ path, schema: SAMPLE_SCHEMA }),
          /unexpected response shape/
        );
      }
    )
  );
});

test("extractStructured rejects a missing path or schema before any network call", async () => {
  const path = fixture("invoice5.pdf");
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse(REALISTIC_EXTRACTION_RESPONSE);
      },
      async () => {
        await assert.rejects(() => extractStructured({ schema: SAMPLE_SCHEMA }), /requires a `path`/);
        await assert.rejects(() => extractStructured({ path }), /requires a `schema`/);
        assert.equal(calls, 0, "invalid input must fail before any fetch call");
      }
    )
  );
});

test("extractStructured rejects a missing file before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse(REALISTIC_EXTRACTION_RESPONSE);
      },
      async () => {
        await assert.rejects(
          () => extractStructured({ path: join(dir, "does-not-exist.pdf"), schema: SAMPLE_SCHEMA }),
          /File not found/
        );
        assert.equal(calls, 0);
      }
    )
  );
});

// --- generateSchema -------------------------------------------------------

test("generateSchema sends model=schema-generate to the SAME /information-extraction endpoint, with the sample file(s)", async () => {
  const path = fixture("sample1.pdf");
  let seenUrl;
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (url, options) => {
        seenUrl = url;
        seenOptions = options;
        return jsonResponse({ schema: SAMPLE_SCHEMA });
      },
      async () => {
        const result = await generateSchema({ paths: [path] });

        assert.match(seenUrl, /\/information-extraction$/);
        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="model"\r\n\r\nschema-generate/);
        assert.match(bodyText, /name="document"; filename="sample1\.pdf"\r\nContent-Type: application\/pdf/);

        assert.deepEqual(result, { schema: SAMPLE_SCHEMA });
      }
    )
  );
});

test("generateSchema sends up to 3 sample files in one multipart request", async () => {
  const paths = [fixture("s1.pdf"), fixture("s2.pdf"), fixture("s3.pdf")];
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return jsonResponse({ schema: SAMPLE_SCHEMA });
      },
      async () => {
        await generateSchema({ paths });
        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /filename="s1\.pdf"/);
        assert.match(bodyText, /filename="s2\.pdf"/);
        assert.match(bodyText, /filename="s3\.pdf"/);
        // Only one `model` field regardless of file count.
        assert.equal((bodyText.match(/name="model"/g) || []).length, 1);
      }
    )
  );
});

test("generateSchema falls back to parsing a synthetic tool-call response when there's no `schema` field", async () => {
  const path = fixture("sample2.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        jsonResponse({
          tool_calls: [{ function: { arguments: JSON.stringify(SAMPLE_SCHEMA) } }]
        }),
      async () => {
        const result = await generateSchema({ paths: [path] });
        assert.deepEqual(result, { schema: SAMPLE_SCHEMA });
      }
    )
  );
});

test("generateSchema throws on an unexpected response shape", async () => {
  const path = fixture("sample3.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () => jsonResponse({ unexpected: true }),
      async () => {
        await assert.rejects(() => generateSchema({ paths: [path] }), /unexpected response shape/);
      }
    )
  );
});

test("generateSchema rejects an empty paths array before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse({ schema: SAMPLE_SCHEMA });
      },
      async () => {
        await assert.rejects(() => generateSchema({ paths: [] }), /at least 1 sample document path/);
        await assert.rejects(() => generateSchema({}), /requires a `paths` array/);
        assert.equal(calls, 0, "invalid paths must fail before any fetch call");
      }
    )
  );
});

test("generateSchema rejects a paths array over MAX_SCHEMA_SAMPLE_PATHS entries before any network call", async () => {
  const paths = [fixture("a.pdf"), fixture("b.pdf"), fixture("c.pdf"), fixture("d.pdf")];
  let calls = 0;
  assert.equal(MAX_SCHEMA_SAMPLE_PATHS, 3);
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse({ schema: SAMPLE_SCHEMA });
      },
      async () => {
        await assert.rejects(() => generateSchema({ paths }), /at most 3 sample document paths/);
        assert.equal(calls, 0, "over-cap paths must fail before any fetch call");
      }
    )
  );
});

test("generateSchema rejects non-string/empty-string path entries before any network call", async () => {
  const path = fixture("sample4.pdf");
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse({ schema: SAMPLE_SCHEMA });
      },
      async () => {
        await assert.rejects(() => generateSchema({ paths: [path, ""] }), /non-empty string/);
        await assert.rejects(() => generateSchema({ paths: [path, 123] }), /non-empty string/);
        await assert.rejects(() => generateSchema({ paths: [path, null] }), /non-empty string/);
        assert.equal(calls, 0, "invalid path entries must fail before any fetch call");
      }
    )
  );
});

test("generateSchema rejects a missing sample file before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return jsonResponse({ schema: SAMPLE_SCHEMA });
      },
      async () => {
        await assert.rejects(
          () => generateSchema({ paths: [join(dir, "does-not-exist.pdf")] }),
          /File not found/
        );
        assert.equal(calls, 0);
      }
    )
  );
});
