// `upstage ocr` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `ocrDocument()` (src/upstage/documents.mjs). No
// format/mode/ocr flags — those are `parse`'s concern; `ocrDocument()`
// always runs the dedicated `ocr` model with a fixed markdown/standard shape
// (see documents.mjs's own comment on why).
import { ocrDocument } from "../../upstage/documents.mjs";
import { parseArgs, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage ocr <file> [--json]",
      "",
      "Runs OCR-only digitization on a document (PDF/image) via Upstage's dedicated OCR model.",
      "",
      "Options:",
      "  --json     Output the raw result as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(result) {
  return `${result.elements.length} element(s), ${result.pageCount} page(s)\n\n${result.markdown}\n`;
}

export async function runOcrCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, positionals } = parseArgs(rest);
  const file = positionals[0];

  if (!file) {
    process.stderr.write("upstage ocr: missing required <file> argument\n");
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage ocr: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let result;
  try {
    result = await ocrDocument({ path: file });
  } catch (err) {
    process.stderr.write(`upstage ocr: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err);
  }

  process.stdout.write(json ? JSON.stringify(result) : formatHuman(result));
  return 0;
}
