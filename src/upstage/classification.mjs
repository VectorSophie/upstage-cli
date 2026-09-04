// Upstage Document Classification — POST /document-classification, a
// multipart upload with `model: "document-classify"`. Confirmed via
// docs/superpowers/plans/2026-09-04-3.2.0-release-plan.md §3 (cross-checked
// against myeolinmalchi/upstage-cli's actual implementation, described there
// as "high-confidence, cross-source-confirmed").
//
// Categories are **user-defined**, not a fixed taxonomy: the caller supplies
// the candidate labels, and they're sent as a `oneOf`/`const` enum on a
// `document_type` property inside `response_format.json_schema` — the same
// OpenAI-style structured-output convention every Upstage endpoint in this
// repo follows. Max 1,000 categories is Upstage's documented cap.
//
// IMPORTANT — unlike documents.mjs/embeddings.mjs (whose request/response
// shapes this session was able to cross-check against a working reference
// implementation's exact wire format), this session had no live API key
// available, so the exact `response_format` nesting in buildResponseFormat()
// and the confidence-score field path in normalizeResponse() below are a
// best-effort reading of plan §3's researched-but-not-live-verified
// description ("synthetic tool_calls[0].function.arguments.document_type
// .confidence_score"). Verify against a real API call before relying on
// this in production — see the plan doc's §3 (Classification row) and §13.
//
// This module owns classification API calls + response normalization only.
// No document-parsing/OCR/extraction/embedding logic lives here.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { upstageRequest } from "./client.mjs";
import { SUPPORTED_EXTENSIONS } from "./documents.mjs";

const ENDPOINT = "/document-classification";
const MODEL = "document-classify";

// A single category can't be "classified" against (there's nothing to
// distinguish it from), and Upstage documents a hard cap of 1,000 classes —
// both are enforced client-side, before any network call, per this task's
// acceptance criteria.
export const MIN_CATEGORIES = 2;
export const MAX_CATEGORIES = 1000;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function validateCategories(categories) {
  if (!Array.isArray(categories)) {
    throw new Error("classifyDocument() requires a `categories` array");
  }
  if (categories.length < MIN_CATEGORIES) {
    throw new Error(
      `classifyDocument() requires at least ${MIN_CATEGORIES} categories to choose between, got ${categories.length}`
    );
  }
  if (categories.length > MAX_CATEGORIES) {
    throw new Error(
      `classifyDocument() supports at most ${MAX_CATEGORIES} categories (Upstage's documented cap), got ${categories.length}`
    );
  }
  categories.forEach((category, i) => {
    if (typeof category !== "string" || !category.trim()) {
      throw new Error(
        `classifyDocument() requires every category to be a non-empty string, got ${JSON.stringify(category)} at index ${i}`
      );
    }
  });
}

async function loadFile(path) {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  const buffer = await readFile(path);
  // Reuses documents.mjs's extension→MIME table (same 7 extensions apply
  // here) so the two modules can't independently drift, as
  // solar-embedding's stale duplicate model names once did (see
  // embeddings.mjs's header) — but unlike documents.mjs's loadFile,
  // classification isn't documented as restricted to this format set, so an
  // unrecognized extension still gets uploaded (as application/octet-stream)
  // rather than rejected client-side.
  const contentType = SUPPORTED_EXTENSIONS[extname(path).toLowerCase()] || DEFAULT_CONTENT_TYPE;
  return { buffer, contentType, filename: path.split(/[/\\]/).pop() };
}

// Builds the categories-as-oneOf/const JSON schema per plan §3's documented
// shape. See the module header for the "not live-verified" caveat.
function buildResponseFormat(categories) {
  return {
    type: "json_schema",
    json_schema: {
      name: "document_type",
      schema: {
        type: "object",
        properties: {
          document_type: {
            type: "string",
            oneOf: categories.map((category) => ({ const: category }))
          }
        }
      }
    }
  };
}

// See the module header's "not live-verified" caveat — this is a best-effort
// reading of plan §3's description of a synthetic tool-call response shape,
// not a confirmed byte-for-byte parse.
function normalizeResponse(data) {
  const toolCall = data?.tool_calls?.[0];
  let args = toolCall?.function?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = undefined;
    }
  }

  const documentType = args?.document_type;
  const label = typeof documentType === "string" ? documentType : documentType?.label ?? documentType?.value;
  const confidence = typeof documentType?.confidence_score === "number" ? documentType.confidence_score : undefined;

  if (typeof label !== "string" || !label) {
    throw new Error("Upstage classification API returned an unexpected response shape");
  }

  return { label, confidence };
}

/**
 * Classify a document (PDF/image) into one of a caller-supplied set of
 * categories via Upstage's Document Classification model.
 *
 * @param {object} options
 * @param {string} options.path - absolute or relative path to the file to classify.
 * @param {string[]} options.categories - candidate labels (2 to 1,000 entries).
 * @returns {Promise<{label: string, confidence: number|undefined}>}
 * @throws {Error} if `categories` has fewer than 2 or more than 1,000
 *   entries (checked before any network call), or if the file doesn't exist.
 */
export async function classifyDocument({ path, categories } = {}) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("classifyDocument() requires a `path`");
  }
  validateCategories(categories);

  const { buffer, contentType, filename } = await loadFile(path);

  const data = await upstageRequest({
    path: ENDPOINT,
    isMultipart: true,
    formFields: {
      model: MODEL,
      response_format: JSON.stringify(buildResponseFormat(categories))
    },
    fileField: { buffer, filename, contentType }
  });

  return normalizeResponse(data);
}
