// `upstage classify` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `classifyDocument()` (src/upstage/classification.mjs).
// `--categories` is required, comma-separated, split into an array before
// being passed on (classifyDocument itself enforces the 2..1000 count/
// non-empty-string constraints — see that module's validateCategories()).
import { classifyDocument } from "../../upstage/classification.mjs";
import { parseArgs, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage classify <file> --categories <a,b,c> [--json]",
      "",
      "Classifies a document (PDF/image) into one of a caller-supplied set of categories,",
      "via Upstage's Document Classification model.",
      "",
      "Options:",
      "  --categories   Required. Comma-separated candidate labels (2 to 1000).",
      "  --json         Output the raw result as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(result) {
  const confidence = typeof result.confidence === "number" ? ` (confidence: ${result.confidence})` : "";
  return `${result.label}${confidence}\n`;
}

export async function runClassifyCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, flags, positionals } = parseArgs(rest, ["--categories"]);
  const file = positionals[0];
  const categoriesFlag = flags["--categories"];

  if (!file) {
    process.stderr.write("upstage classify: missing required <file> argument\n");
    return 2;
  }
  if (!categoriesFlag) {
    process.stderr.write("upstage classify: missing required --categories <a,b,c> flag\n");
    return 2;
  }

  const categories = categoriesFlag.split(",").map((c) => c.trim()).filter(Boolean);
  if (categories.length === 0) {
    process.stderr.write("upstage classify: --categories must contain at least one non-empty label\n");
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage classify: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let result;
  try {
    result = await classifyDocument({ path: file, categories });
  } catch (err) {
    process.stderr.write(`upstage classify: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err);
  }

  process.stdout.write(json ? JSON.stringify(result) : formatHuman(result));
  return 0;
}
