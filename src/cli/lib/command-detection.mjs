// Project command detection — a single, narrowly-scoped helper that answers
// "does this project have a lint/typecheck/test command configured?" by
// reading `package.json`'s `scripts`.
//
// Deliberately shared (not duplicated) by two 3.2.0 tasks that both need this
// exact answer:
//   - Task 12.3's `upstage doctor` (Verification section)
//   - Task 7.10/7.J's real `/init` (build/test/lint/typecheck detection)
//
// Detection only — this module never *executes* a detected command, only
// reports what it found. Node/Bun `package.json` scripts are the only
// ecosystem handled for 3.2 (this repo is itself a Node/Bun project, and the
// task's own scope note says not to over-engineer beyond that).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Longest/most-specific keys are matched first within each category so e.g.
// "typecheck" wins over a looser substring match before "type" would.
const LINT_KEYS = ["lint"];
const TYPECHECK_KEYS = ["typecheck", "type-check", "type:check", "tsc"];
const TEST_KEYS = ["test"];

function firstMatchingScript(scripts, keys) {
  const entries = Object.entries(scripts);
  for (const key of keys) {
    for (const [scriptName, command] of entries) {
      const lower = scriptName.toLowerCase();
      if (lower === key || lower.includes(key)) {
        return { script: scriptName, command };
      }
    }
  }
  return null;
}

/**
 * Reads `<cwd>/package.json` and reports which of lint/typecheck/test
 * commands appear to be configured under `scripts`. Never throws — a
 * missing/unreadable/malformed `package.json` just yields all-null.
 *
 * @param {string} [cwd]
 * @returns {Promise<{
 *   lint: { script: string, command: string } | null,
 *   typecheck: { script: string, command: string } | null,
 *   test: { script: string, command: string } | null
 * }>}
 */
export async function detectProjectCommands(cwd = process.cwd()) {
  const result = { lint: null, typecheck: null, test: null };

  let pkg;
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    pkg = JSON.parse(raw);
  } catch {
    return result;
  }

  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};

  result.lint = firstMatchingScript(scripts, LINT_KEYS);
  result.typecheck = firstMatchingScript(scripts, TYPECHECK_KEYS);
  result.test = firstMatchingScript(scripts, TEST_KEYS);

  return result;
}
