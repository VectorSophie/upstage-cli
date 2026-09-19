import { resolve } from "node:path";
import { parseDocument } from "../../upstage/documents.mjs";

// Upstage Document AI (OCR + Layout Analysis + Parse) — a capability gap
// most coding-agent tool registries have no equivalent for at all: read a
// scanned PDF, a photographed whiteboard, a screenshot of an error dialog,
// a design spec image. Upstage's own docs claim 95% OCR/layout accuracy
// and specifically call out strength on Korean text and complex layouts.
//
// The actual API call + response normalization live in ../../upstage/documents.mjs
// (shared with any other Document Parse/OCR caller, e.g. future standalone
// `upstage parse`/`upstage ocr` commands). This file is purely the tool-contract
// adapter: resolve the path, call parseDocument(), reshape the result into the
// `{path, elementCount, markdown}` shape this tool has always returned.
//
// File existence/extension/size validation is intentionally NOT duplicated
// here — parseDocument()'s own loadFile() (in documents.mjs) already performs
// those checks and throws before any network call. Re-checking here would
// just run the same three checks twice on every call.
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

    const result = await parseDocument({ path: absolutePath, format: "markdown", mode: "standard", ocr: "auto" });

    return {
      path: args.path,
      elementCount: result.elements.length,
      markdown: result.markdown || "(no content extracted)"
    };
  }
};
