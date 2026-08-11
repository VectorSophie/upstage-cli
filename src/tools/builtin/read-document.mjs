import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { request } from "node:https";

// Upstage Document AI (OCR + Layout Analysis + Parse) — a capability gap
// most coding-agent tool registries have no equivalent for at all: read a
// scanned PDF, a photographed whiteboard, a screenshot of an error dialog,
// a design spec image. Upstage's own docs claim 95% OCR/layout accuracy
// and specifically call out strength on Korean text and complex layouts.
//
// Request/response shape confirmed from langchain-upstage's
// UpstageDocumentParseParser (the actual SDK implementation, not guessed):
// POST multipart/form-data to https://api.upstage.ai/v1/document-digitization
// with a `document` file field + form fields (model/ocr/output_formats/...),
// response is `{ elements: [{ content: { markdown, html, text }, category, page }, ...] }`
// — one entry per detected layout element, concatenated here into one
// document-level string.
const ENDPOINT = "https://api.upstage.ai/v1/document-digitization";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // Upstage's own documented cap
const CONTENT_TYPE_BY_EXT = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic"
};

function buildMultipartBody(fields, fileField) {
  const boundary = `----upstage-cli-${Date.now().toString(16)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileField.filename}"\r\n` +
      `Content-Type: ${fileField.contentType}\r\n\r\n`
    ),
    fileField.buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return { boundary, body: Buffer.concat(parts) };
}

function postMultipart(url, apiKey, fields, fileField) {
  const { boundary, body } = buildMultipartBody(fields, fileField);
  const parsed = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length
        },
        timeout: 60000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            return reject(new Error(`Document AI API ${res.statusCode}: ${text.slice(0, 500)}`));
          }
          try {
            resolvePromise(JSON.parse(text));
          } catch (err) {
            reject(new Error(`Failed to parse Document AI response: ${err.message}`));
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Document AI request timed out")); });
    req.write(body);
    req.end();
  });
}

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
    const contentType = CONTENT_TYPE_BY_EXT[ext];
    if (!contentType) {
      throw new Error(`Unsupported file type: ${ext || "(none)"}. Supported: ${Object.keys(CONTENT_TYPE_BY_EXT).join(", ")}`);
    }

    const buffer = await readFile(absolutePath);
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_BYTES})`);
    }

    const data = await postMultipart(
      ENDPOINT,
      apiKey,
      {
        model: "document-parse",
        ocr: "auto",
        output_formats: "['markdown']",
        coordinates: "false",
        chart_recognition: "true",
        base64_encoding: "[]"
      },
      { buffer, filename: absolutePath.split("/").pop(), contentType }
    );

    const elements = Array.isArray(data.elements) ? data.elements : [];
    const markdown = elements
      .map((el) => el?.content?.markdown || el?.content?.text || "")
      .filter(Boolean)
      .join("\n\n");

    return {
      path: args.path,
      elementCount: elements.length,
      markdown: markdown || "(no content extracted)"
    };
  }
};
