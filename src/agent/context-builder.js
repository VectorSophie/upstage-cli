import { retrieveRelevantChunks } from "../retriever/index.js";

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

export async function buildContext({
  input,
  registry,
  cwd,
  runtimeCache,
  maxFiles = 6,
  maxCharsPerFile = 2000
}) {
  const keywords = extractKeywords(input);

  const repoMap = await registry.execute("repo_map", { maxFiles: 100 }, { cwd, runtimeCache });
  const mapData = repoMap.ok ? repoMap.data : { totalFiles: 0, map: "" };

  const candidates = new Set();
  for (const keyword of keywords) {
    const symbolMatches = await registry.execute("find_symbol", { name: keyword }, { cwd, runtimeCache });
    if (symbolMatches.ok && Array.isArray(symbolMatches.data.matches)) {
      for (const item of symbolMatches.data.matches) {
        if (item.file) {
          candidates.add(item.file);
        }
        if (candidates.size >= maxFiles) {
          break;
        }
      }
    }
    if (candidates.size >= maxFiles) {
      break;
    }
  }

  for (const keyword of keywords) {
    const search = await registry.execute("search_code", { pattern: keyword, maxResults: 6 }, { cwd, runtimeCache });
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

  const selectedFiles = Array.from(candidates).slice(0, maxFiles);
  const snippets = [];

  for (const relativePath of selectedFiles) {
    const result = await registry.execute("read_file", { path: relativePath }, { cwd, runtimeCache });
    if (!result.ok) {
      continue;
    }
    snippets.push({
      path: relativePath,
      content: result.data.content.slice(0, maxCharsPerFile)
    });
  }

  const retrievalQuery = keywords.join(" ") || input;
  const retrieval = await retrieveRelevantChunks({
    cwd,
    query: retrievalQuery,
    runtimeCache,
    topK: 5
  }).catch(() => ({ mode: "none", fromCache: false, chunks: [] }));

  return {
    keywords,
    repoSummary: {
      totalFiles: mapData.totalFiles,
      map: mapData.map || ""
    },
    modules: await registry
      .execute("list_modules", {}, { cwd, runtimeCache })
      .then((res) => (res.ok ? res.data.modules.slice(0, 20) : [])),
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
    lines.push(context.repoSummary.map);
  }
  if (Array.isArray(context.modules) && context.modules.length > 0) {
    lines.push("- module edges:");
    for (const module of context.modules.slice(0, 12)) {
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
      lines.push(chunk.text.slice(0, 400));
      lines.push("```");
    }
  }
  return lines.join("\n");
}
