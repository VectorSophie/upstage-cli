import { retrieveRelevantChunks } from "../retriever/index.mjs";

function extractKeywords(prompt) {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 8);
}

const MAX_CONTEXT_CHARS = 24_000; // hard cap: keep well under Solar Pro2's 65k token limit

export async function buildContext({
  input,
  registry,
  cwd,
  runtimeCache,
  maxFiles = 5,
  maxCharsPerFile = 1500
}) {
  const keywords = extractKeywords(input);

  const repoMap = await registry.execute("repo_map", { maxFiles: 30 }, { cwd, runtimeCache });
  const mapData = repoMap.ok ? repoMap.data : { totalFiles: 0, map: "" };

  const candidates = new Set();
  const symbolResults = await Promise.all(
    keywords.map((keyword) =>
      registry.execute("find_symbol", { name: keyword }, { cwd, runtimeCache })
    )
  );
  for (const symbolMatches of symbolResults) {
    if (!symbolMatches.ok || !Array.isArray(symbolMatches.data.matches)) {
      continue;
    }
    for (const item of symbolMatches.data.matches) {
      if (item.file) {
        candidates.add(item.file);
      }
      if (candidates.size >= maxFiles) {
        break;
      }
    }
    if (candidates.size >= maxFiles) {
      break;
    }
  }

  if (candidates.size < maxFiles) {
    const searchResults = await Promise.all(
      keywords.map((keyword) =>
        registry.execute("search_code", { pattern: keyword, maxResults: 6 }, { cwd, runtimeCache })
      )
    );
    for (const search of searchResults) {
      if (!search.ok || !Array.isArray(search.data.matches)) {
        continue;
      }
      for (const match of search.data.matches) {
        candidates.add(match.path);
        if (candidates.size >= maxFiles) {
          break;
        }
      }
      if (candidates.size >= maxFiles) {
        break;
      }
    }
  }

  // Glob tier: filename-like keywords (contains dot or dash) → direct file discovery
  if (candidates.size < maxFiles) {
    const filePatternKeywords = keywords.filter((k) => (k.includes(".") || k.includes("-")) && k.length > 4);
    // Also try adjacent keyword pairs as potential kebab-case filenames
    const pairs = [];
    for (let i = 0; i < keywords.length - 1; i++) {
      pairs.push(`${keywords[i]}-${keywords[i + 1]}`);
    }
    const globTargets = [...filePatternKeywords, ...pairs.slice(0, 4)].slice(0, 6);
    if (globTargets.length > 0) {
      const globResults = await Promise.all(
        globTargets.map((k) =>
          registry.execute("glob", { pattern: `**/*${k}*` }, { cwd, runtimeCache }).catch(() => null)
        )
      );
      for (const gr of globResults) {
        if (!gr?.ok || !Array.isArray(gr.data?.files)) continue;
        for (const file of gr.data.files.slice(0, 3)) {
          candidates.add(file);
          if (candidates.size >= maxFiles) break;
        }
        if (candidates.size >= maxFiles) break;
      }
    }
  }

  // Call-graph tier: find_references for top symbols to discover connected files
  if (candidates.size < maxFiles) {
    const refResults = await Promise.all(
      keywords.slice(0, 4).map((k) =>
        registry.execute("find_references", { symbol: k }, { cwd, runtimeCache }).catch(() => null)
      )
    );
    for (const rr of refResults) {
      if (!rr?.ok || !Array.isArray(rr.data?.references)) continue;
      for (const ref of rr.data.references) {
        const file = ref.file || ref.path;
        if (file) {
          candidates.add(file);
          if (candidates.size >= maxFiles) break;
        }
      }
      if (candidates.size >= maxFiles) break;
    }
  }

  const selectedFiles = Array.from(candidates).slice(0, maxFiles);
  const snippetResults = await Promise.all(
    selectedFiles.map((relativePath) =>
      registry.execute("read_file", { path: relativePath }, { cwd, runtimeCache })
    )
  );
  const snippets = [];
  for (let i = 0; i < selectedFiles.length; i += 1) {
    const relativePath = selectedFiles[i];
    const result = snippetResults[i];
    if (!result.ok) {
      continue;
    }
    snippets.push({
      path: relativePath,
      content: result.data.content.slice(0, maxCharsPerFile)
    });
  }

  const retrievalQuery = keywords.join(" ") || input;
  const [retrieval, modulesResult] = await Promise.all([
    retrieveRelevantChunks({
      cwd,
      query: retrievalQuery,
      runtimeCache,
      topK: 5
    }).catch(() => ({ mode: "none", fromCache: false, chunks: [] })),
    registry.execute("list_modules", {}, { cwd, runtimeCache })
  ]);

  return {
    keywords,
    repoSummary: {
      totalFiles: mapData.totalFiles,
      map: mapData.map || ""
    },
    modules: modulesResult.ok ? modulesResult.data.modules.slice(0, 20) : [],
    snippets,
    retrieval
  };
}

export function formatContextForModel(context) {
  const lines = [];
  lines.push("Repository context:");
  lines.push(`- totalFiles: ${context.repoSummary.totalFiles}`);
  lines.push(`- keywordHints: ${context.keywords.join(", ") || "none"}`);
  if (context.repoSummary.map) {
    lines.push("- repository map (condensed):");
    // Cap repo map to avoid flooding the context
    lines.push(context.repoSummary.map.slice(0, 4000));
  }
  if (Array.isArray(context.modules) && context.modules.length > 0) {
    lines.push("- module edges:");
    for (const module of context.modules.slice(0, 8)) {
      lines.push(`  - ${module.file} -> ${(module.imports || []).slice(0, 3).join(", ") || "(none)"}`);
    }
  }
  if (context.snippets.length > 0) {
    lines.push("- relevant snippets:");
  }
  for (const snippet of context.snippets) {
    lines.push(`FILE: ${snippet.path}`);
    lines.push("```text");
    lines.push(snippet.content);
    lines.push("```");
  }
  if (Array.isArray(context.retrieval?.chunks) && context.retrieval.chunks.length > 0) {
    lines.push(`- semantic retrieval (mode=${context.retrieval.mode}):`);
    for (const chunk of context.retrieval.chunks) {
      lines.push(`  - ${chunk.path} (score=${chunk.score})`);
      lines.push("```text");
      lines.push(chunk.text.slice(0, 300));
      lines.push("```");
    }
  }
  const result = lines.join("\n");
  if (result.length > MAX_CONTEXT_CHARS) {
    return result.slice(0, MAX_CONTEXT_CHARS) + "\n... (context truncated)";
  }
  return result;
}
