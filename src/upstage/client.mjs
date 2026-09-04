// Shared HTTP client for every Upstage-calling tool/provider (Document AI,
// embeddings, groundedness check, retriever provider, ...). Centralizes:
//   - base URL / auth conventions (matches src/model/upstage-adapter.mjs exactly:
//     UPSTAGE_API_BASE_URL, UPSTAGE_API_KEY, `Authorization: Bearer <key>`)
//   - retry-on-429/5xx via the existing fetchWithRetry (src/model/fetch-utils.mjs)
//     rather than reimplementing backoff logic
//   - multipart/form-data encoding, ported from the hand-rolled node:https
//     builder in src/tools/builtin/read-document.mjs (that file is not yet
//     wired to this client — a later task does that)
//
// Deliberately has no per-endpoint knowledge (no document/embedding/
// groundedness-specific fields or paths) — that belongs in the small
// endpoint-specific modules that will sit alongside this file.
import { fetchWithRetry, isRetriableStatus } from "../model/fetch-utils.mjs";
import { UpstageApiError } from "./errors.mjs";

const DEFAULT_BASE_URL = process.env.UPSTAGE_API_BASE_URL || "https://api.upstage.ai/v1";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_FILE_FIELD_NAME = "document";

// Byte-for-byte the same boundary/field layout as read-document.mjs's
// buildMultipartBody: one part per form field, then a final part carrying
// the file with its own Content-Disposition + Content-Type, terminated by
// the closing boundary line.
//
// `fileField` is normally a single {buffer, filename, contentType, fieldName?}
// object (the original, still-most-common shape), but extraction.mjs's
// schema-generation call needs up to 3 sample documents in one multipart
// request — so this also accepts an array of that same shape, emitting one
// file part per entry (all under the same default field name unless each
// entry overrides it). This is a minimal, backward-compatible extension:
// every existing caller keeps passing a single object and sees no change.
function buildMultipartBody(formFields, fileField) {
  const boundary = `----upstage-cli-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(formFields || {})) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  }
  const fileFields = Array.isArray(fileField) ? fileField : [fileField];
  for (const file of fileFields) {
    const fieldName = file.fieldName || DEFAULT_FILE_FIELD_NAME;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`
      ),
      file.buffer,
      Buffer.from(`\r\n`)
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function resolvePath(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

async function parseErrorBody(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Make an authenticated, retrying request to the Upstage API.
 *
 * @param {object} options
 * @param {string} options.path - API path, e.g. "/document-digitization" (or an absolute URL).
 * @param {string} [options.method="POST"]
 * @param {object} [options.body] - JSON body (ignored when isMultipart is true).
 * @param {boolean} [options.isMultipart=false]
 * @param {object} [options.formFields] - multipart-only: plain string form fields.
 * @param {{buffer: Buffer, filename: string, contentType: string, fieldName?: string}|Array<{buffer: Buffer, filename: string, contentType: string, fieldName?: string}>} [options.fileField] - multipart-only. A single file, or an array of files (e.g. schema-generation's up-to-3-samples case) all sent in the same multipart body.
 * @param {string} [options.apiKey] - defaults to process.env.UPSTAGE_API_KEY.
 * @param {string} [options.baseUrl] - defaults to process.env.UPSTAGE_API_BASE_URL or the public API.
 * @param {number} [options.timeoutMs=60000]
 * @returns {Promise<any>} parsed JSON response body.
 * @throws {UpstageApiError}
 */
export async function upstageRequest({
  path,
  method = "POST",
  body,
  isMultipart = false,
  formFields,
  fileField,
  apiKey,
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!path || typeof path !== "string") {
    throw new UpstageApiError("upstageRequest requires a `path`", { retryable: false });
  }

  // Resolve and validate the API key BEFORE touching the network — one of
  // this module's required behaviors (missing key must not cost a request).
  const resolvedApiKey = apiKey || process.env.UPSTAGE_API_KEY;
  if (!resolvedApiKey) {
    throw new UpstageApiError("UPSTAGE_API_KEY is not configured", { retryable: false });
  }

  const resolvedBaseUrl = baseUrl || DEFAULT_BASE_URL;
  const url = resolvePath(resolvedBaseUrl, path);

  const headers = { Authorization: `Bearer ${resolvedApiKey}` };
  let requestBody;

  if (isMultipart) {
    const fileFieldEntries = Array.isArray(fileField) ? fileField : [fileField];
    if (fileFieldEntries.length === 0 || fileFieldEntries.some((file) => !file || !file.buffer)) {
      throw new UpstageApiError("multipart request requires fileField.buffer", { retryable: false });
    }
    const { boundary, body: multipartBody } = buildMultipartBody(formFields, fileField);
    headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    requestBody = multipartBody;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetchWithRetry(() => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { method, headers, body: requestBody, signal: controller.signal }).finally(() =>
        clearTimeout(timer)
      );
    });
  } catch (error) {
    if (error instanceof UpstageApiError) throw error;
    throw new UpstageApiError(`Upstage API request failed: ${error.message}`, {
      retryable: false,
      code: error.name
    });
  }

  if (!response.ok) {
    const errorBody = await parseErrorBody(response);
    throw new UpstageApiError(`Upstage API error (${response.status})`, {
      status: response.status,
      retryable: isRetriableStatus(response.status),
      body: errorBody
    });
  }

  try {
    return await response.json();
  } catch (error) {
    throw new UpstageApiError("Upstage API returned a non-JSON success response", {
      status: response.status,
      retryable: false,
      code: error.name
    });
  }
}
