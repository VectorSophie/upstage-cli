import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

const MAX_BYTES = 500_000;
const MAX_OUTPUT_CHARS = 20_000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? httpsGet : httpGet;
    const req = lib(url, { timeout: 15000, headers: { "User-Agent": "upstage-cli/2.0 (web_fetch)" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return fetchUrl(next, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        chunks.push(chunk);
        if (total > MAX_BYTES) req.destroy(new Error("response_too_large"));
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), contentType: res.headers["content-type"] || "" }));
      res.on("error", reject);
    });
    req.on("error", (e) => {
      if (e.message === "response_too_large") return resolve({ body: "[truncated — response exceeded size limit]", contentType: "" });
      reject(e);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

export const webFetchTool = {
  name: "web_fetch",
  description: "Fetch a URL and return its content as plain text (HTML stripped). Useful for reading documentation.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" }
    },
    required: ["url"],
    additionalProperties: false
  },
  async execute(args) {
    if (typeof args.url !== "string" || !args.url.startsWith("http")) {
      throw new Error("url must start with http:// or https://");
    }

    const { body, contentType } = await fetchUrl(args.url);
    const isHtml = contentType.includes("html") || body.trimStart().startsWith("<!DOCTYPE") || body.trimStart().startsWith("<html");
    const text = isHtml ? stripHtml(body) : body;
    const truncated = text.length > MAX_OUTPUT_CHARS;

    return {
      url: args.url,
      contentType,
      text: truncated ? text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[...truncated]" : text,
      truncated
    };
  }
};
