import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatContextForModel } from "../src/agent/context-builder.mjs";

describe("formatContextForModel model-aware truncation", () => {
  it("uses a larger character budget for solar-pro4 than solar-pro2", () => {
    const bigSnippet = { path: "big.js", content: "x".repeat(300_000) };
    const context = {
      keywords: [],
      repoSummary: { totalFiles: 1, map: "" },
      modules: [],
      snippets: [bigSnippet],
      retrieval: { chunks: [] }
    };

    const pro2Result = formatContextForModel(context, { modelId: "solar-pro2" });
    const pro4Result = formatContextForModel(context, { modelId: "solar-pro4" });

    assert.ok(pro4Result.length > pro2Result.length);
    assert.ok(pro2Result.includes("(context truncated)"));
  });

  it("defaults to the existing ~24k char budget when no modelId is given", () => {
    const bigSnippet = { path: "big.js", content: "x".repeat(50_000) };
    const context = {
      keywords: [],
      repoSummary: { totalFiles: 1, map: "" },
      modules: [],
      snippets: [bigSnippet],
      retrieval: { chunks: [] }
    };
    const result = formatContextForModel(context);
    assert.ok(result.length <= 24_100); // 24_000 + "... (context truncated)" suffix slack
  });
});
