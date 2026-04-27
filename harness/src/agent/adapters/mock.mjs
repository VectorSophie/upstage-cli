import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { CodingAgent } from "../interface.mjs";

/**
 * MockAgent reads README.fixture.md from the fixture repo for the expected patch
 * and applies it directly. Used for CI smoke tests without model API calls.
 *
 * README.fixture.md format:
 *   ## Expected Fix
 *   ### file: path/to/file.py
 *   ```
 *   full new content
 *   ```
 */
export class MockAgent extends CodingAgent {
  get id() {
    return "mock";
  }

  get displayName() {
    return "Mock Agent (CI)";
  }

  isAvailable() {
    return true;
  }

  async run(task, context) {
    const workdir = context.workdir;
    const readmePath = join(workdir, "README.fixture.md");

    if (!existsSync(readmePath)) {
      return {
        ok: false,
        error: "README.fixture.md not found in fixture repo — cannot apply mock fix",
        turns: 0,
        toolCalls: 0,
        usage: null,
        events: []
      };
    }

    const readme = readFileSync(readmePath, "utf8");
    const fixes = parseFixes(readme);

    if (fixes.length === 0) {
      return {
        ok: false,
        error: "No '## Expected Fix' section with file blocks found in README.fixture.md",
        turns: 0,
        toolCalls: 0,
        usage: null,
        events: []
      };
    }

    for (const { filePath, content } of fixes) {
      const absPath = resolve(workdir, filePath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf8");
    }

    return {
      ok: true,
      turns: 1,
      toolCalls: fixes.length,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      events: [{ type: "mock_fix_applied", files: fixes.map((f) => f.filePath) }],
      stopReason: "end_turn"
    };
  }
}

function parseFixes(readme) {
  const fixes = [];
  const fileBlockRe = /###\s+file:\s+(.+?)\n```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = fileBlockRe.exec(readme)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    fixes.push({ filePath, content });
  }
  return fixes;
}
