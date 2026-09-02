import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { collectWorkspaceFiles } from "../tools/lib/fs-utils.mjs";
import { parseSourceFile, isCodeFile } from "./parsers/adapter.mjs";
import {
  loadIntelligenceIndexFromDisk,
  saveIntelligenceIndexToDisk
} from "./store.mjs";

function resolveImport(filePath, importPath, fileSet) {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const base = resolve(dirname(filePath), importPath);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.jsx`,
    resolve(base, "index.js"),
    resolve(base, "index.ts")
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function toRepoPath(cwd, filePath) {
  return relative(cwd, filePath).split("\\").join("/");
}

async function buildFileSignatures(cwd, codeFiles) {
  const signatures = {};
  for (const filePath of codeFiles) {
    const info = await stat(filePath);
    signatures[toRepoPath(cwd, filePath)] = {
      mtimeMs: info.mtimeMs,
      size: info.size
    };
  }
  return signatures;
}

function sameSignatureMap(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!right[key]) {
      return false;
    }
    if (left[key].mtimeMs !== right[key].mtimeMs || left[key].size !== right[key].size) {
      return false;
    }
  }
  return true;
}

export async function buildIntelligenceIndex(cwd, options = {}) {
  const files = await collectWorkspaceFiles(cwd, {
    maxFiles: options.maxFiles || 800,
    maxDepth: options.maxDepth || 10
  });
  const codeFiles = files.filter((filePath) => isCodeFile(filePath));
  const fileSet = new Set(codeFiles);
  const signatures = await buildFileSignatures(cwd, codeFiles);

  const cached = options.forceRebuild ? null : await loadIntelligenceIndexFromDisk(cwd);

  if (cached && sameSignatureMap(cached.fileSignatures, signatures)) {
    return {
      ...cached,
      createdAt: Date.now(),
      fromCache: true
    };
  }

  // Incremental reindex: only reparse files whose mtime/size changed (or are
  // new); reuse the cached symbols/imports for everything else instead of
  // reparsing the whole repo on every single-file edit.
  const unchangedRelPaths = new Set();
  const changedFiles = [];
  for (const filePath of codeFiles) {
    const relPath = toRepoPath(cwd, filePath);
    const prevSig = cached?.fileSignatures?.[relPath];
    const nextSig = signatures[relPath];
    if (prevSig && prevSig.mtimeMs === nextSig.mtimeMs && prevSig.size === nextSig.size) {
      unchangedRelPaths.add(relPath);
    } else {
      changedFiles.push(filePath);
    }
  }

  const symbols = [];
  const importsByFile = {};
  const references = new Map();

  if (cached) {
    for (const symbol of cached.symbols || []) {
      if (unchangedRelPaths.has(symbol.file)) {
        symbols.push(symbol);
      }
    }
    for (const [relPath, deps] of Object.entries(cached.importsByFile || {})) {
      if (unchangedRelPaths.has(relPath)) {
        importsByFile[relPath] = deps;
      }
    }
  }

  for (const filePath of changedFiles) {
    const content = await readFile(filePath, "utf8");
    const relPath = toRepoPath(cwd, filePath);
    const parsed = await parseSourceFile({
      filePath,
      relativePath: relPath,
      content
    });

    symbols.push(...parsed.symbols);

    const deps = [];
    for (const importPath of parsed.imports) {
      const resolved = resolveImport(filePath, importPath, fileSet);
      if (resolved) {
        deps.push(toRepoPath(cwd, resolved));
      }
    }
    importsByFile[relPath] = deps;
  }

  for (const symbol of symbols) {
    if (!references.has(symbol.name)) {
      references.set(symbol.name, []);
    }
    references.get(symbol.name).push({
      file: symbol.file,
      line: symbol.line,
      kind: symbol.kind
    });
  }

  const index = {
    createdAt: Date.now(),
    symbols,
    importsByFile,
    references: Object.fromEntries(references.entries()),
    fileSignatures: signatures,
    parserMode: "tree-sitter-ready-regex"
  };

  await saveIntelligenceIndexToDisk(cwd, index);
  return {
    ...index,
    fromCache: false
  };
}

export function rankRepoMap(index, query = "") {
  const queryLower = query.toLowerCase();
  const fileScores = new Map();

  for (const file of Object.keys(index.fileSignatures)) {
    let score = 0;
    if (queryLower && file.toLowerCase().includes(queryLower)) {
      score += 10;
    }
    fileScores.set(file, score);
  }

  if (queryLower) {
    for (const symbol of index.symbols) {
      if (symbol.name.toLowerCase().includes(queryLower)) {
        const current = fileScores.get(symbol.file) || 0;
        fileScores.set(symbol.file, current + 5);
      }
    }
  }

  const sortedFiles = Array.from(fileScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  const repoMap = sortedFiles.map(file => {
    const fileSymbols = index.symbols
      .filter(s => s.file === file)
      .slice(0, 5)
      .map(s => s.name)
      .join(", ");
    return `${file}${fileSymbols ? ` (${fileSymbols})` : ""}`;
  });

  return repoMap.join("\n");
}

export function findSymbol(index, name) {
  const needle = name.toLowerCase();
  return index.symbols.filter((symbol) => symbol.name.toLowerCase().includes(needle));
}

export function findReferences(index, symbolName) {
  return index.references[symbolName] || [];
}

export function listModules(index) {
  return Object.entries(index.importsByFile).map(([file, imports]) => ({ file, imports }));
}

export function getIndexHealth(index) {
  const fileCount = Object.keys(index.fileSignatures || {}).length;
  return {
    parserMode: index.parserMode || "unknown",
    fromCache: index.fromCache === true,
    fileCount,
    symbolCount: Array.isArray(index.symbols) ? index.symbols.length : 0,
    createdAt: index.createdAt
  };
}
