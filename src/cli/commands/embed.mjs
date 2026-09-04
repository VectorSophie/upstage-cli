// `upstage embed` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `embed()` (src/upstage/embeddings.mjs). Text is a
// single positional arg, wrapped into the single-element `texts` array
// `embed()` expects; `--type` defaults to "query" (embed()'s own default).
//
// EMBED-VECTOR-OUTPUT DECISION: `embed()` returns a 1,024-dimensional vector
// (solar-embedding-2, per embeddings.mjs's header) per input text. Dumping
// that raw — 1,024 floats — to a human-facing terminal by default is not
// useful output; nobody reads a wall of floats to understand "did this
// work." So the human-readable (non-`--json`) rendering below shows the
// dimension count and a short, clearly-labeled preview (first 5 values)
// instead of the full vector. `--json` output is UNAFFECTED by this
// decision — it prints the complete, untruncated result (the raw
// `number[][]` `embed()` returns), since that's the actual data a
// machine-readable consumer (a script piping this into something else)
// needs; truncating JSON output would silently corrupt it for that use case.
import { embed } from "../../upstage/embeddings.mjs";
import { parseArgs, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

const PREVIEW_COUNT = 5;

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage embed <text> [--type query|passage] [--json]",
      "",
      "Embeds a single text via Upstage's Solar embeddings.",
      "",
      "Options:",
      "  --type   query|passage — which side of a search this text represents (default: query)",
      "  --json   Output the raw result (an array containing one embedding vector) as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(vector) {
  const preview = vector.slice(0, PREVIEW_COUNT).join(", ");
  return `${vector.length}-dimensional vector. First ${Math.min(PREVIEW_COUNT, vector.length)} values: [${preview}]\n`;
}

export async function runEmbedCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, flags, positionals } = parseArgs(rest, ["--type"]);
  const text = positionals[0];
  const type = flags["--type"] ?? "query";

  if (!text) {
    process.stderr.write("upstage embed: missing required <text> argument\n");
    return 2;
  }
  if (type !== "query" && type !== "passage") {
    process.stderr.write(`upstage embed: --type must be one of query|passage, got "${type}"\n`);
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage embed: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let vectors;
  try {
    vectors = await embed({ texts: [text], type });
  } catch (err) {
    process.stderr.write(`upstage embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err);
  }

  process.stdout.write(json ? JSON.stringify(vectors) : formatHuman(vectors[0]));
  return 0;
}
