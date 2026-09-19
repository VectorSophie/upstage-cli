// inspect_image(path, question) — 3.3.0 Thread D, Task D.3. The optional,
// non-blocking vision sidecar: Solar is text-only, so screenshot evidence
// (browser_screenshot, Task C.3) needs a separate, bounded model call to be
// interpreted at all. A single specialist call, never a second autonomous
// agent.
//
// Per the owner decision (design doc §D): registered only when a usable
// image-capable adapter is configured (GEMINI_API_KEY/GOOGLE_API_KEY
// present) — src/tools/create-registry.mjs checks isVisionSidecarConfigured()
// before calling registry.register(inspectImageTool) at all. No key means
// the tool is simply absent, never present-but-erroring, so a verification
// pipeline (Thread E) treats its absence as "skip this stage."

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { GeminiAdapter } from "../../model/gemini-adapter.mjs";
import { writeArtifact } from "../../runtime/artifacts.mjs";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function guessMimeType(path) {
  return MIME_BY_EXT[extname(path).toLowerCase()] || "application/octet-stream";
}

export function isVisionSidecarConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

export const inspectImageTool = {
  name: "inspect_image",
  description: "Ask a vision-capable model a question about an image (e.g. a browser_screenshot evidence artifact) — optional, only available when a vision-sidecar API key is configured",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      question: { type: "string" }
    },
    required: ["path", "question"],
    additionalProperties: false
  },
  async execute(args, context) {
    const bytes = await readFile(args.path);
    const adapter = context?.__adapterOverride || new GeminiAdapter();

    const result = await adapter.complete({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.question },
            { type: "image", source: { type: "base64", data: bytes.toString("base64"), mimeType: guessMimeType(args.path) } }
          ]
        }
      ],
      stream: false
    });

    const answer = result.content;
    const sessionId = context?.session?.id;
    if (!sessionId) return { answer };

    const artifact = await writeArtifact(sessionId, { kind: "vision-response", ext: "txt", data: answer });
    return { answer, artifact };
  }
};
