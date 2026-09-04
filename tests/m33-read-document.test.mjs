import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDocumentTool } from "../src/tools/builtin/read-document.mjs";
import { MAX_FILE_BYTES } from "../src/upstage/documents.mjs";

// read_document had zero test coverage before this file (see the 3.2.0
// release plan, §2/§4/Task 7.2). No ESM module-mocking is available on this
// project's plain `node --test` invocation (no --experimental-test-module-mocks,
// no mocking library) so — matching tests/m33-upstage-client.test.mjs and
// tests/m33-upstage-documents.test.mjs — these tests exercise the tool through
// its real dependency (src/upstage/documents.mjs's parseDocument) with
// global.fetch mocked underneath it. This still verifies exactly what's
// asked: the tool's own validation (unsupported type, oversized file) and its
// {path, elementCount, markdown} adaptation of parseDocument's result.
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
  dir = mkdtempSync(join(tmpdir(), "upstage-read-document-test-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name, bytes = Buffer.from("fake-file-bytes")) {
  writeFileSync(join(dir, name), bytes);
  return name;
}

test("read_document adapts a successful parse into {path, elementCount, markdown}", async () => {
  const relPath = fixture("report.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        new Response(
          JSON.stringify({
            elements: [
              { page: 1, content: { markdown: "# Report" } },
              { page: 1, content: { markdown: "Some findings." } }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      async () => {
        const result = await readDocumentTool.execute({ path: relPath }, { cwd: dir });
        assert.deepEqual(result, {
          path: relPath,
          elementCount: 2,
          markdown: "# Report\n\nSome findings."
        });
      }
    )
  );
});

test("read_document falls back to a placeholder when no content was extracted", async () => {
  const relPath = fixture("blank.pdf");
  await withApiKey(() =>
    withMockFetch(
      async () =>
        new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      async () => {
        const result = await readDocumentTool.execute({ path: relPath }, { cwd: dir });
        assert.equal(result.elementCount, 0);
        assert.equal(result.markdown, "(no content extracted)");
      }
    )
  );
});

test("read_document throws when UPSTAGE_API_KEY is not configured, without calling fetch", async () => {
  const relPath = fixture("needs-key.pdf");
  const original = process.env.UPSTAGE_API_KEY;
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
          () => readDocumentTool.execute({ path: relPath }, { cwd: dir }),
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

test("read_document requires a path argument", async () => {
  await withApiKey(async () => {
    await assert.rejects(() => readDocumentTool.execute({}, { cwd: dir }), /path is required/);
  });
});

test("read_document throws when the file does not exist, without calling fetch", async () => {
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => readDocumentTool.execute({ path: "nope.pdf" }, { cwd: dir }),
          /File not found: nope\.pdf/
        );
        assert.equal(calls, 0);
      }
    )
  );
});

test("read_document rejects an unsupported file type, without calling fetch", async () => {
  const relPath = fixture("notes.txt");
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => readDocumentTool.execute({ path: relPath }, { cwd: dir }),
          /Unsupported file type: \.txt/
        );
        assert.equal(calls, 0);
      }
    )
  );
});

test("read_document rejects a file larger than the size cap, without calling fetch", async () => {
  const relPath = fixture("huge.pdf", Buffer.alloc(MAX_FILE_BYTES + 1));
  let calls = 0;
  await withApiKey(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => readDocumentTool.execute({ path: relPath }, { cwd: dir }),
          /File too large/
        );
        assert.equal(calls, 0);
      }
    )
  );
});
