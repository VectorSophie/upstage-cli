import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Spec-driven memory — persist feature specs/architecture notes into `UPSTAGE.md`
 * (which is auto-merged into the system prompt), so the agent references them
 * across turns. This is the "context engineering" pattern: durable intent the
 * model reads on every request.
 */

const SPEC_HEADING = "## Specs";

function specFile(cwd = process.cwd()) {
  return join(cwd, "UPSTAGE.md");
}

/** Append a timestamped spec entry under a `## Specs` section. Returns { path, entry }. */
export async function appendSpec(cwd = process.cwd(), text = "") {
  const entry = String(text || "").trim();
  if (!entry) throw new Error("spec text is required");

  const path = specFile(cwd);
  let content = "";
  if (existsSync(path)) content = await readFile(path, "utf8");

  const stamp = new Date().toISOString().slice(0, 10);
  const block = `- (${stamp}) ${entry}`;

  if (content.includes(SPEC_HEADING)) {
    // Insert under the existing heading.
    content = content.replace(SPEC_HEADING, `${SPEC_HEADING}\n${block}`);
  } else {
    const sep = content.trim().length > 0 ? "\n\n" : "";
    content = `${content}${sep}${SPEC_HEADING}\n${block}\n`;
  }
  await writeFile(path, content, "utf8");
  return { path, entry: block };
}

/** Return the current Specs section (entries), or "" if none. */
export async function readSpecs(cwd = process.cwd()) {
  const path = specFile(cwd);
  if (!existsSync(path)) return "";
  const content = await readFile(path, "utf8");
  const idx = content.indexOf(SPEC_HEADING);
  if (idx === -1) return "";
  const rest = content.slice(idx + SPEC_HEADING.length);
  // Stop at the next top-level heading.
  const next = rest.search(/\n##\s/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}
