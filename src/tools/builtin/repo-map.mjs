import { extname, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { collectWorkspaceFiles } from "../lib/fs-utils.mjs";
import { parseSourceFile } from "../../indexer/parsers/adapter.mjs";

export const repoMapTool = {
  name: "repo_map",
  description: "Build a concise repository map with files and key symbols (functions, classes)",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      maxFiles: { type: "number" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    const maxFiles = Number.isInteger(args.maxFiles) ? args.maxFiles : 100;
    const files = await collectWorkspaceFiles(context.cwd, {
      maxFiles,
      maxDepth: 5
    });

    const repoStructure = [];

    for (const filePath of files) {
      const relPath = relative(context.cwd, filePath).split("\\").join("/");
      const ext = extname(filePath).toLowerCase();

      let symbols = [];
      try {
        const content = await readFile(filePath, "utf8");
        const parseResult = await parseSourceFile({ filePath, relativePath: relPath, content });
        symbols = parseResult.symbols || [];
      } catch (e) {
      }

      repoStructure.push({
        file: relPath,
        extension: ext,
        symbols: symbols.slice(0, 10)
      });
    }

    const formattedMap = repoStructure.map(item => {
      const symbolNames = item.symbols.map(s => s.name).join(", ");
      return `${item.file}${symbolNames ? ` (${symbolNames})` : ""}`;
    }).join("\n");

    return {
      totalFiles: files.length,
      map: formattedMap
    };
  }
};

