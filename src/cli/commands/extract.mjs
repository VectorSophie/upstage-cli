// `upstage extract` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `extractStructured()` (src/upstage/extraction.mjs).
// `--schema` is required and supports both inline JSON text and `@file.json`
// (read-from-file) syntax, resolved+parsed entirely at this layer — a
// malformed schema (either form) is a usage error (exit 2), never reaches
// the network.
import { extractStructured } from "../../upstage/extraction.mjs";
import { parseArgs, resolveTextOrFile, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage extract <file> --schema <json|@file> [--json]",
      "",
      "Extracts structured data from a document (PDF/image) matching a JSON Schema, via",
      "Upstage's Universal Extraction model.",
      "",
      "Options:",
      "  --schema   Required. Inline JSON Schema text, or @path/to/schema.json to read from a file.",
      "  --json     Output the raw result as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function runExtractCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, flags, positionals } = parseArgs(rest, ["--schema"]);
  const file = positionals[0];
  const schemaFlag = flags["--schema"];

  if (!file) {
    process.stderr.write("upstage extract: missing required <file> argument\n");
    return 2;
  }
  if (!schemaFlag) {
    process.stderr.write("upstage extract: missing required --schema <json|@file> flag\n");
    return 2;
  }

  let schemaText;
  try {
    schemaText = resolveTextOrFile(schemaFlag);
  } catch (err) {
    process.stderr.write(`upstage extract: ${err.message}\n`);
    return 2;
  }

  let schema;
  try {
    schema = JSON.parse(schemaText);
  } catch (err) {
    process.stderr.write(`upstage extract: --schema is not valid JSON: ${err.message}\n`);
    return 2;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    process.stderr.write("upstage extract: --schema must be a JSON object\n");
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage extract: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let result;
  try {
    result = await extractStructured({ path: file, schema });
  } catch (err) {
    process.stderr.write(`upstage extract: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err);
  }

  process.stdout.write(json ? JSON.stringify(result) : formatHuman(result));
  return 0;
}
