// Upstage Document Digitization (Document Parse + OCR) — one endpoint,
// `model` field selects the mode ("document-parse" | "document-parse-nightly"
// | "ocr"). Confirmed via docs/superpowers/plans/2026-09-04-3.2.0-release-plan.md
// §3 (cross-checked against langchain-upstage's UpstageDocumentParseParser and
// this repo's own prior hand-rolled implementation).
//
// POST multipart/form-data to /document-digitization with a `document` file
// field + form fields (model/ocr/mode/output_formats/...). Response shape:
// `{ elements: [{ content: { markdown, html, text }, category, page }, ...] }`
// — one entry per detected layout element.
//
// This module owns API calls + response normalization only. No tool/CLI-
// specific adaptation (e.g. read_document's `{path, elementCount, markdown}`
// contract) lives here — that belongs to the caller.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { upstageRequest } from "./client.mjs";

const ENDPOINT = "/document-digitization";

// Upstage's own documented cap for the sync endpoint's file size.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic"
};

// `output_formats` is sent as a multipart string field (everything in
// multipart/form-data is a string) — this is the exact Python-list-repr
// serialization this repo's original hand-rolled implementation used
// ("['markdown']"), preserved here rather than switched to real JSON syntax
// since that's the convention already proven to work against the live API.
const OUTPUT_FORMATS_BY_FORMAT = {
  markdown: "['markdown']",
  html: "['html']",
  text: "['text']"
};

async function loadFile(path) {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  const ext = extname(path).toLowerCase();
  const contentType = SUPPORTED_EXTENSIONS[ext];
  if (!contentType) {
    throw new Error(
      `Unsupported file type: ${ext || "(none)"}. Supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")}`
    );
  }
  const buffer = await readFile(path);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_BYTES})`);
  }
  return { buffer, contentType, filename: path.split(/[/\\]/).pop() };
}

// Elements carry a `page` number; pageCount is the highest page seen (1-based),
// or 0 when no elements were returned at all.
function computePageCount(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return 0;
  return Math.max(...elements.map((el) => (typeof el?.page === "number" ? el.page : 1)));
}

function normalizeResponse(data, format) {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const key = format === "text" ? "text" : format === "html" ? "html" : "markdown";
  // Fall back through the other content shapes (skipping `key` itself, since
  // trying it twice is dead code) in case the API didn't populate the
  // requested one for a given element.
  const fallbackKeys = ["markdown", "text"].filter((k) => k !== key);
  const combined = elements
    .map((el) => {
      const content = el?.content || {};
      return content[key] || fallbackKeys.map((k) => content[k]).find(Boolean) || "";
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    elements,
    markdown: format === "text" ? "" : combined,
    text: format === "text" ? combined : "",
    pageCount: computePageCount(elements)
  };
}

async function digitize({ path, model, format, mode, ocr }) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("path is required");
  }

  const { buffer, contentType, filename } = await loadFile(path);

  const formFields = {
    model,
    output_formats: OUTPUT_FORMATS_BY_FORMAT[format] || OUTPUT_FORMATS_BY_FORMAT.markdown,
    coordinates: "false",
    chart_recognition: "true",
    base64_encoding: "[]"
  };
  if (mode) formFields.mode = mode;
  if (ocr) formFields.ocr = ocr;

  const data = await upstageRequest({
    path: ENDPOINT,
    isMultipart: true,
    formFields,
    fileField: { buffer, filename, contentType }
  });

  return normalizeResponse(data, format);
}

/**
 * Parse a document (PDF/image) via Upstage's Document Parse model, returning
 * structured layout elements plus the requested output format's combined text.
 *
 * @param {object} options
 * @param {string} options.path - absolute or relative path to the file to parse.
 * @param {"markdown"|"html"|"text"} [options.format="markdown"]
 * @param {"standard"|"enhanced"|"auto"} [options.mode="standard"]
 * @param {"auto"|"force"} [options.ocr="auto"]
 * @returns {Promise<{elements: object[], markdown: string, text: string, pageCount: number}>}
 */
export async function parseDocument({ path, format = "markdown", mode = "standard", ocr = "auto" } = {}) {
  return digitize({ path, model: "document-parse", format, mode, ocr });
}

/**
 * Run OCR-only digitization via Upstage's dedicated `ocr` model.
 *
 * @param {object} options
 * @param {string} options.path - absolute or relative path to the file to OCR.
 * @returns {Promise<{elements: object[], markdown: string, text: string, pageCount: number}>}
 */
export async function ocrDocument({ path } = {}) {
  // Deliberately omits the `ocr` form field (unlike parseDocument's
  // `ocr: "auto"` default): that field toggles whether document-parse runs
  // OCR on top of an existing text layer, which is meaningless once `model`
  // is already "ocr". `mode` is still sent for form-field-shape parity with
  // parseDocument. NOTE: this reasoning has not been confirmed against a
  // live API call — verify before relying on it if `ocr`'s actual behavior
  // under model: "ocr" turns out to matter.
  return digitize({ path, model: "ocr", format: "markdown", mode: "standard" });
}
