import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDocument, ocrDocument, MAX_FILE_BYTES, SUPPORTED_EXTENSIONS } from "../src/upstage/documents.mjs";

// This repo has no ESM module-mocking available without an experimental Node
// flag (verified: node:test's mock.module()/t.mock.module() both throw
// "is not a function" on this project's plain `node --test` invocation), so
// — matching the pattern already used in tests/m33-upstage-client.test.mjs —
// these tests mock global.fetch, the actual network boundary underneath
// upstageRequest, rather than upstageRequest itself.
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

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "upstage-docs-test-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name, bytes = Buffer.from("fake-file-bytes")) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const REALISTIC_RESPONSE = {
  elements: [
    { category: "heading1", page: 1, content: { markdown: "# Title", html: "<h1>Title</h1>", text: "Title" } },
    { category: "paragraph", page: 1, content: { markdown: "Body text.", html: "<p>Body text.</p>", text: "Body text." } },
    { category: "paragraph", page: 2, content: { markdown: "Page two.", html: "<p>Page two.</p>", text: "Page two." } }
  ]
};

test("parseDocument sends the document-parse model with markdown defaults and normalizes the response", async () => {
  const path = fixture("doc.pdf");
  let seenUrl;
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (url, options) => {
        seenUrl = url;
        seenOptions = options;
        return new Response(JSON.stringify(REALISTIC_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      async () => {
        const result = await parseDocument({ path });

        assert.match(seenUrl, /\/document-digitization$/);
        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="model"\r\n\r\ndocument-parse/);
        assert.match(bodyText, /name="output_formats"\r\n\r\n\['markdown'\]/);
        assert.match(bodyText, /name="mode"\r\n\r\nstandard/);
        assert.match(bodyText, /name="ocr"\r\n\r\nauto/);
        assert.match(bodyText, /name="document"; filename="doc\.pdf"\r\nContent-Type: application\/pdf/);

        assert.equal(result.elements.length, 3);
        assert.equal(result.markdown, "# Title\n\nBody text.\n\nPage two.");
        assert.equal(result.text, "");
        assert.equal(result.pageCount, 2);
      }
    )
  );
});

test("parseDocument passes format/mode/ocr through and requests text output_formats", async () => {
  const path = fixture("doc2.pdf");
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return new Response(
          JSON.stringify({ elements: [{ page: 1, content: { text: "plain text body" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
      async () => {
        const result = await parseDocument({ path, format: "text", mode: "enhanced", ocr: "force" });

        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="output_formats"\r\n\r\n\['text'\]/);
        assert.match(bodyText, /name="mode"\r\n\r\nenhanced/);
        assert.match(bodyText, /name="ocr"\r\n\r\nforce/);

        assert.equal(result.text, "plain text body");
        assert.equal(result.markdown, "");
        assert.equal(result.pageCount, 1);
      }
    )
  );
});

test("ocrDocument sends the ocr model", async () => {
  const path = fixture("scan.png");
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return new Response(JSON.stringify({ elements: [{ page: 1, content: { markdown: "scanned text" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      async () => {
        const result = await ocrDocument({ path });

        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="model"\r\n\r\nocr/);
        assert.match(bodyText, /name="document"; filename="scan\.png"\r\nContent-Type: image\/png/);

        assert.equal(result.markdown, "scanned text");
        assert.equal(result.pageCount, 1);
      }
    )
  );
});

test("ocrDocument's exact form-field set: model=ocr, mode=standard, no `ocr` field", async () => {
  // Locks in the behavior explained in the comment above ocrDocument() in
  // documents.mjs (code-quality review Issue 2): the `ocr` field is
  // deliberately absent when model is already "ocr", but `mode` is still
  // sent. If this ever changes, this test should force an explicit,
  // deliberate update rather than a silent regression.
  const path = fixture("scan2.png");
  let seenOptions;
  await withApiKey(() =>
    withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      async () => {
        await ocrDocument({ path });

        const bodyText = Buffer.from(seenOptions.body).toString("utf8");
        assert.match(bodyText, /name="model"\r\n\r\nocr\r\n/);
        assert.match(bodyText, /name="mode"\r\n\r\nstandard\r\n/);
        assert.match(bodyText, /name="output_formats"\r\n\r\n\['markdown'\]\r\n/);
        assert.match(bodyText, /name="coordinates"\r\n\r\nfalse\r\n/);
        assert.match(bodyText, /name="chart_recognition"\r\n\r\ntrue\r\n/);
        assert.match(bodyText, /name="base64_encoding"\r\n\r\n\[\]\r\n/);
        assert.doesNotMatch(bodyText, /name="ocr"\r\n/);
      }
    )
  );
});

test("pageCount is 0 when the response has no elements", async () => {
  const path = fixture("empty.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      async () => {
        const result = await parseDocument({ path });
        assert.equal(result.pageCount, 0);
        assert.equal(result.elements.length, 0);
        assert.equal(result.markdown, "");
      }
    )
  );
});

test("parseDocument rejects an unsupported file type before any network call", async () => {
  const path = fixture("notes.txt");
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => parseDocument({ path }),
          (err) => {
            assert.match(err.message, /Unsupported file type: \.txt/);
            return true;
          }
        );
        assert.equal(calls, 0);
      }
    )
  );
});

test("parseDocument rejects a file over MAX_FILE_BYTES before any network call", async () => {
  const path = fixture("huge.pdf", Buffer.alloc(MAX_FILE_BYTES + 1));
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => parseDocument({ path }),
          (err) => {
            assert.match(err.message, /File too large/);
            return true;
          }
        );
        assert.equal(calls, 0);
      }
    )
  );
});

test("parseDocument rejects a missing file before any network call", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => parseDocument({ path: join(dir, "does-not-exist.pdf") }),
          (err) => {
            assert.match(err.message, /File not found/);
            return true;
          }
        );
        assert.equal(calls, 0);
      }
    )
  );
});

test("SUPPORTED_EXTENSIONS covers pdf/png/jpg/jpeg/tiff/tif/heic", () => {
  assert.deepEqual(Object.keys(SUPPORTED_EXTENSIONS), [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".heic"]);
});
