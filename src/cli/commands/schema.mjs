// `upstage schema` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `generateSchema()` (src/upstage/extraction.mjs).
// Takes MULTIPLE positional file arguments (1 to 3 sample documents).
//
// The ">3 files" cap is already enforced inside `generateSchema()` itself
// (thrown as a plain Error, before any network call) — this file ALSO checks
// it up front for a clearer, command-specific usage message (per the task's
// suggestion), rather than relying solely on the service function's generic
// message. Both paths land on exit code 2 either way (see
// upstage-command-helpers.mjs's `exitCodeForError` doc comment for why a
// plain Error from this module is treated as a usage error, not a general
// one) — the early check is purely a UX nicety, not a different outcome.
import { generateSchema, MAX_SCHEMA_SAMPLE_PATHS } from "../../upstage/extraction.mjs";
import { parseArgs, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage schema <files...> [--json]",
      "",
      `Generates a JSON Schema from 1 to ${MAX_SCHEMA_SAMPLE_PATHS} sample documents, via Upstage's schema-generation model.`,
      "",
      "Options:",
      "  --json     Output the raw result as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(result) {
  return `${JSON.stringify(result.schema, null, 2)}\n`;
}

export async function runSchemaCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, positionals } = parseArgs(rest);

  if (positionals.length === 0) {
    process.stderr.write("upstage schema: missing required <files...> argument(s)\n");
    return 2;
  }
  if (positionals.length > MAX_SCHEMA_SAMPLE_PATHS) {
    process.stderr.write(
      `upstage schema: supports at most ${MAX_SCHEMA_SAMPLE_PATHS} sample document paths, got ${positionals.length}\n`
    );
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage schema: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let result;
  try {
    result = await generateSchema({ paths: positionals });
  } catch (err) {
    process.stderr.write(`upstage schema: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err);
  }

  process.stdout.write(json ? JSON.stringify(result) : formatHuman(result));
  return 0;
}
