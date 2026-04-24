import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache"
]);

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".css",
  ".html",
  ".sh",
  ".txt"
]);

export function resolveWorkspacePath(cwd, relativePath = ".") {
  const workspaceRoot = resolve(cwd);
  const absolutePath = resolve(workspaceRoot, relativePath);
  const normalizedRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return absolutePath;
}

function normalizeIgnorePattern(pattern) {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function matchesSimplePattern(pathValue, pattern) {
  if (!pattern) {
    return false;
  }
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.slice(0, -1);
    return pathValue === dirPattern || pathValue.startsWith(`${dirPattern}/`);
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"))
        .join(".*")}$`
    );
    return regex.test(pathValue);
  }
  return pathValue === pattern || pathValue.endsWith(`/${pattern}`);
}

export async function loadGitignorePatterns(rootPath) {
  const gitignorePath = resolve(rootPath, ".gitignore");
  try {
    const content = await readFile(gitignorePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(normalizeIgnorePattern);
  } catch {
    return [];
  }
}

function shouldIgnoreRelativePath(relativePath, gitignorePatterns) {
  const normalized = normalizeIgnorePattern(relativePath);
  return gitignorePatterns.some((pattern) => matchesSimplePattern(normalized, pattern));
}

export async function collectFiles(rootPath, options = {}) {
  const {
    maxFiles = 300,
    maxDepth = 6,
    includeHidden = false,
    ignoredDirs = DEFAULT_IGNORED_DIRS,
    gitignorePatterns = []
  } = options;
  const output = [];

  async function walk(currentPath, depth) {
    if (output.length >= maxFiles || depth > maxDepth) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= maxFiles) {
        return;
      }
      if (!includeHidden && entry.name.startsWith(".")) {
        if (entry.name !== ".env.example") {
          continue;
        }
      }

      const fullPath = resolve(currentPath, entry.name);
      const relativePath = relative(rootPath, fullPath).split("\\").join("/");
      if (shouldIgnoreRelativePath(relativePath, gitignorePatterns)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) {
          continue;
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  }

  await walk(rootPath, 0);
  return output;
}

export async function isLikelyTextFile(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }
  const info = await stat(filePath);
  return info.size <= 1024 * 1024;
}

export async function collectWorkspaceFiles(cwd, options = {}) {
  const root = resolveWorkspacePath(cwd, ".");
  const gitignorePatterns = await loadGitignorePatterns(root);
  return collectFiles(root, {
    ...options,
    gitignorePatterns
  });
}
