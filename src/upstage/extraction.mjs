// Upstage Universal Extraction + Schema Generation — both live on the SAME
// endpoint, `POST /v1/information-extraction`, distinguished only by the
// `model` form field. Confirmed via
// docs/superpowers/plans/2026-09-04-3.2.0-release-plan.md §3.
//
// - extractStructured(): model: "information-extract" — caller supplies a
//   JSON Schema (root properties restricted by Upstage to
//   string|integer|number|array, no nested arrays), sent via
//   `response_format.json_schema`, same OpenAI-style structured-output
//   convention classification.mjs already uses. Response parsed from the
//   same synthetic tool_calls[0].function.arguments shape classification.mjs
//   documented (best-effort, not live-verified — see that module's header).
//
// - generateSchema(): model: "schema-generate" — see the ENDPOINT-CHOICE
//   comment directly above buildSchemaGenerationRequest() below for the
//   genuine unresolved discrepancy this task's research turned up, and why
//   this implementation picked the endpoint it did.
//
// This module owns extraction/schema-generation API calls + response
// normalization only. No document-parsing/OCR/classification/embedding/
// groundedness logic lives here.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { upstageRequest } from "./client.mjs";
import { SUPPORTED_EXTENSIONS } from "./documents.mjs";

const ENDPOINT = "/information-extraction";
const EXTRACT_MODEL = "information-extract";
const SCHEMA_GENERATE_MODEL = "schema-generate";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// Schema generation accepts sample document images to infer a schema from —
// Upstage's documented cap is 3.
export const MAX_SCHEMA_SAMPLE_PATHS = 3;

async function loadFile(path) {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  const buffer = await readFile(path);
  // Reuses documents.mjs's extension→MIME table, same rationale as
  // classification.mjs's loadFile: extraction isn't documented as restricted
  // to that exact format set either, so an unrecognized extension still
  // gets uploaded (as application/octet-stream) rather than rejected
  // client-side.
  const contentType = SUPPORTED_EXTENSIONS[extname(path).toLowerCase()] || DEFAULT_CONTENT_TYPE;
  return { buffer, contentType, filename: path.split(/[/\\]/).pop() };
}

// See the module header's "not live-verified" caveat (shared with
// classification.mjs) — wraps the caller's JSON Schema in the
// response_format.json_schema envelope every Upstage structured-output
// endpoint in this repo uses. Unlike classification's fixed `document_type`
// field, the caller's schema here is arbitrary, so there's no fixed name to
// give the envelope; `schema.title` is used when present (a common JSON
// Schema convention) with a generic fallback otherwise.
function buildResponseFormat(schema) {
  return {
    type: "json_schema",
    json_schema: {
      name: (schema && schema.title) || "extraction_schema",
      schema
    }
  };
}

// Shared by normalizeExtractionResponse() and normalizeGeneratedSchema()
// below — both responses are (best-effort, not live-verified — see the
// module header's caveat, shared with classification.mjs's identical
// pattern) read from the same synthetic
// tool_calls[0].function.arguments shape, JSON-parsed when the API sends
// arguments as a string rather than an already-parsed object. Returns
// `undefined` (rather than throwing) when nothing usable is found, so each
// caller can decide its own fallback/error message.
function extractToolCallArguments(data) {
  let args = data?.tool_calls?.[0]?.function?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  return args && typeof args === "object" ? args : undefined;
}

// See the module header's "not live-verified" caveat — best-effort reading
// of the same synthetic tool-call response shape classification.mjs
// documented, applied here to an arbitrary caller-supplied schema instead of
// a fixed document_type field. Verify against a real API call before relying
// on this in production — see plan §3/§13.
function normalizeExtractionResponse(data) {
  const args = extractToolCallArguments(data);

  if (!args) {
    throw new Error("Upstage extraction API returned an unexpected response shape");
  }

  return args;
}

/**
 * Extract structured data from a document (PDF/image) matching a
 * caller-supplied JSON Schema, via Upstage's Universal Extraction model.
 *
 * @param {object} options
 * @param {string} options.path - absolute or relative path to the file to extract from.
 * @param {object} options.schema - a JSON Schema object describing the fields to extract.
 * @returns {Promise<object>} the extracted data itself, shaped however the
 *   caller's `schema` defines it — unwrapped (unlike generateSchema()'s
 *   `{schema}` envelope, which wraps because the schema IS the whole result;
 *   here the result's shape is caller-defined, so there's nothing generic to
 *   wrap it in).
 * @throws {Error} if `path` or `schema` is missing, or the file doesn't exist.
 */
export async function extractStructured({ path, schema } = {}) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("extractStructured() requires a `path`");
  }
  if (!schema || typeof schema !== "object") {
    throw new Error("extractStructured() requires a `schema` object");
  }

  const { buffer, contentType, filename } = await loadFile(path);

  const data = await upstageRequest({
    path: ENDPOINT,
    isMultipart: true,
    formFields: {
      model: EXTRACT_MODEL,
      response_format: JSON.stringify(buildResponseFormat(schema))
    },
    fileField: { buffer, filename, contentType }
  });

  return normalizeExtractionResponse(data);
}

function validateSchemaSamplePaths(paths) {
  if (!Array.isArray(paths)) {
    throw new Error("generateSchema() requires a `paths` array");
  }
  if (paths.length === 0) {
    throw new Error("generateSchema() requires at least 1 sample document path, got 0");
  }
  if (paths.length > MAX_SCHEMA_SAMPLE_PATHS) {
    throw new Error(
      `generateSchema() supports at most ${MAX_SCHEMA_SAMPLE_PATHS} sample document paths (Upstage's documented cap), got ${paths.length}`
    );
  }
  paths.forEach((path, i) => {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error(`generateSchema() requires every path to be a non-empty string, got ${JSON.stringify(path)} at index ${i}`);
    }
  });
}

// ENDPOINT CHOICE — schema generation, the genuinely disputed part of this
// task (see docs/superpowers/plans/2026-09-04-3.2.0-release-plan.md §3/§13
// for the full writeup this comment summarizes):
//
// Two real, independently-researched sources disagree on schema
// generation's endpoint path:
//   (a) Upstage's own first-party machine-readable API reference
//       (console.upstage.ai/api/docs/for-agents/raw) documents schema
//       generation as the SAME endpoint as extraction —
//       `POST /v1/information-extraction` — distinguished only by
//       `model: "schema-generate"` instead of `model: "information-extract"`.
//   (b) A third-party open-source reference implementation
//       (myeolinmalchi/upstage-cli, a small community CLI) instead calls a
//       DIFFERENT sub-path: `POST /v1/information-extraction/schema-generation`.
//
// This implementation uses (a) — the same `/v1/information-extraction`
// endpoint as extractStructured(), with `model: "schema-generate"` — because
// a first-party official API reference is inherently more authoritative than
// a small unofficial project that could itself be relying on stale or
// incorrect information. No live API key was available in this session to
// settle the discrepancy definitively.
//
// ACTION FOR A FUTURE MAINTAINER: verify this against a real API call before
// relying on it in production. If `POST /v1/information-extraction` with
// `model: "schema-generate"` 404s or errors live, try
// `POST /v1/information-extraction/schema-generation` instead (the
// third-party path) and update this comment + plan §3's table with whichever
// one actually works.
function buildSchemaGenerationRequest(fileFields) {
  return {
    path: ENDPOINT,
    isMultipart: true,
    formFields: { model: SCHEMA_GENERATE_MODEL },
    fileField: fileFields
  };
}

// See the module header / buildResponseFormat's caveats — this session could
// not live-verify where schema-generation's response places the generated
// schema. Tried, in order of plausibility: a direct `schema` field (the
// most natural shape for an endpoint whose entire job is "return a schema");
// falling back to the same synthetic tool-call arguments shape the sibling
// extract/classify calls use, in case schema-generate responses are wrapped
// the same way. Verify against a real API call before relying on this in
// production — see plan §3/§13.
function normalizeGeneratedSchema(data) {
  if (data?.schema && typeof data.schema === "object") {
    return data.schema;
  }

  const args = extractToolCallArguments(data);
  if (args) {
    return args;
  }

  throw new Error("Upstage schema-generation API returned an unexpected response shape");
}

/**
 * Generate a JSON Schema from up to 3 sample documents, via Upstage's
 * schema-generation model.
 *
 * @param {object} options
 * @param {string[]} options.paths - 1 to 3 sample document paths.
 * @returns {Promise<{schema: object}>}
 * @throws {Error} if `paths` has 0 entries or more than 3 (checked before
 *   any network call), or if a file doesn't exist.
 */
export async function generateSchema({ paths } = {}) {
  validateSchemaSamplePaths(paths);

  const files = await Promise.all(paths.map((path) => loadFile(path)));
  // Multiple files are sent in one multipart request under the same
  // "document" field name (client.mjs's buildMultipartBody now supports an
  // array of file entries for exactly this case) — this is the most common
  // multi-file multipart convention, but the real API's expectation here is
  // unverified (single field repeated vs. separate field names vs. separate
  // sequential calls per sample). Verify live before relying on this.
  const fileFields = files.map(({ buffer, filename, contentType }) => ({ buffer, filename, contentType }));

  const data = await upstageRequest(buildSchemaGenerationRequest(fileFields));

  return { schema: normalizeGeneratedSchema(data) };
}
