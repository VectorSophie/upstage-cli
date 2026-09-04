import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDocument, SUPPORTED_EXTENSIONS, MAX_FILE_BYTES } from "../../upstage/documents.mjs";

// Upstage Document AI (OCR + Layout Analysis + Parse) — a capability gap
// most coding-agent tool registries have no equivalent for at all: read a
// scanned PDF, a photographed whiteboard, a screenshot of an error dialog,
// a design spec image. Upstage's own docs claim 95% OCR/layout accuracy
// and specifically call out strength on Korean text and complex layouts.
//
// The actual API call + response normalization live in ../../upstage/documents.mjs
// (shared with any other Document Parse/OCR caller, e.g. future standalone
// `upstage parse`/`upstage ocr` commands). This file is purely the tool-contract
// adapter: validate input, call parseDocument(), reshape the result into the
// `{path, elementCount, markdown}` shape this tool has always returned.
export const readDocumentTool = {
  name: "read_document",
  description:
    "Read a non-text document (scanned/photographed PDF, PNG, JPEG, TIFF) via Upstage's Document AI OCR + Layout " +
    "Analysis, returning structured Markdown — for design specs, scanned contracts, whiteboard photos, or error " +
    "screenshots that read_file can't handle. Strong on Korean text and complex layouts (tables, figures).",
  risk: "low",
  actionClass: "network",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the PDF/image file to parse" }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, context = {}) {
    const apiKey = process.env.UPSTAGE_API_KEY;
    if (!apiKey) throw new Error("UPSTAGE_API_KEY is not configured");
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");

    const cwd = context.cwd || process.cwd();
    const absolutePath = resolve(cwd, args.path);
    if (!existsSync(absolutePath)) throw new Error(`File not found: ${args.path}`);

    const ext = extname(absolutePath).toLowerCase();
    const contentType = SUPPORTED_EXTENSIONS[ext];
    if (!contentType) {
      throw new Error(`Unsupported file type: ${ext || "(none)"}. Supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")}`);
    }

    const { size } = await stat(absolutePath);
    if (size > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${size} bytes (max ${MAX_FILE_BYTES})`);
    }

    const result = await parseDocument({ path: absolutePath, format: "markdown", mode: "standard", ocr: "auto" });

    return {
      path: args.path,
      elementCount: result.elements.length,
      markdown: result.markdown || "(no content extracted)"
    };
  }
};
