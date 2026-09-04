// `upstage parse` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `parseDocument()` (src/upstage/documents.mjs). This
// file owns only argv parsing, flag-value mapping, and stdout/exit-code
// formatting — no Document-AI logic lives here.
import { parseDocument } from "../../upstage/documents.mjs";
import { parseArgs, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

// CLI-facing `--format` values (md/html/text) map onto documents.mjs's
// internal `format` param, which spells the markdown case out in full
// ("markdown", not "md") — see documents.mjs's OUTPUT_FORMATS_BY_FORMAT.
const FORMAT_MAP = { md: "markdown", html: "html", text: "text" };
const VALID_MODES = ["standard", "enhanced", "auto"];
const VALID_OCR = ["auto", "force"];

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage parse <file> [--format md|html|text] [--mode standard|enhanced|auto] [--ocr auto|force] [--json]",
      "",
      "Parses a document (PDF/image) into structured layout elements via Upstage's Document Parse model.",
      "",
      "Options:",
      "  --format   Output content format (default: md)",
      "  --mode     Parse mode (default: standard)",
      "  --ocr      OCR behavior (default: auto)",
      "  --json     Output the raw result as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(result) {
  const content = result.text || result.markdown || "";
  const lines = [
    `${result.elements.length} element(s), ${result.pageCount} page(s)`,
    "",
    content
  ];
  return lines.join("\n") + "\n";
}

export async function runParseCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, flags, positionals } = parseArgs(rest, ["--format", "--mode", "--ocr"]);
  const file = positionals[0];

  if (!file) {
    process.stderr.write("upstage parse: missing required <file> argument\n");
    return 2;
  }

  const formatFlag = flags["--format"] ?? "md";
  if (!Object.prototype.hasOwnProperty.call(FORMAT_MAP, formatFlag)) {
    process.stderr.write(`upstage parse: --format must be one of md|html|text, got "${formatFlag}"\n`);
    return 2;
  }
  const format = FORMAT_MAP[formatFlag];

  const mode = flags["--mode"] ?? "standard";
  if (!VALID_MODES.includes(mode)) {
    process.stderr.write(`upstage parse: --mode must be one of ${VALID_MODES.join("|")}, got "${mode}"\n`);
    return 2;
  }

  const ocr = flags["--ocr"] ?? "auto";
  if (!VALID_OCR.includes(ocr)) {
    process.stderr.write(`upstage parse: --ocr must be one of ${VALID_OCR.join("|")}, got "${ocr}"\n`);
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage parse: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let result;
  try {
    result = await parseDocument({ path: file, format, mode, ocr });
  } catch (err) {
    process.stderr.write(`upstage parse: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err);
  }

  process.stdout.write(json ? JSON.stringify(result) : formatHuman(result));
  return 0;
}
