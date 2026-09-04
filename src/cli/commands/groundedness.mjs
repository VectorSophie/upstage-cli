// `upstage groundedness` — Task 7.8 of the 3.2.0 release plan.
//
// Thin CLI adapter over `checkGroundedness()` (src/upstage/groundedness.mjs).
// Both `--context` and `--answer` are required and support the same `@file`
// syntax as extract's `--schema`.
//
// EXIT-CODE MAPPING NOTE (the one place this command's behavior deliberately
// diverges from its six siblings): `checkGroundedness()` calls
// `UpstageAdapter.complete()` directly rather than going through
// `upstageRequest()`/client.mjs (see groundedness.mjs's own header for why),
// which means it throws a plain `Error` for genuine upstream API failures
// too, not just client-side validation — unlike the other six modules, where
// a plain Error can only mean "you gave me bad input" (client.mjs wraps
// every real API/network failure as `UpstageApiError`). Since this command
// already validates `--context`/`--answer` presence and the API key itself
// before ever calling `checkGroundedness()`, whatever plain Error still
// surfaces from that call is most likely an unwrapped API-adjacent failure —
// so this file passes `fallbackCode: 1` ("general/unexpected error") to
// `exitCodeForError`, instead of the other six commands' default of 2. See
// `src/cli/lib/upstage-command-helpers.mjs`'s `exitCodeForError` doc comment
// for the full reasoning.
import { checkGroundedness } from "../../upstage/groundedness.mjs";
import { parseArgs, resolveTextOrFile, hasApiKey, exitCodeForError } from "../lib/upstage-command-helpers.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage groundedness --context <text|@file> --answer <text|@file> [--json]",
      "",
      "Verifies that an answer/claim is supported by its source context, via Upstage's",
      "Groundedness Check (a real second model call, not self-critique).",
      "",
      "Options:",
      "  --context   Required. Inline text, or @path/to/context.txt to read from a file.",
      "  --answer    Required. Inline text, or @path/to/answer.txt to read from a file.",
      "  --json      Output the raw result as JSON"
    ].join("\n") + "\n"
  );
}

export function formatHuman(result) {
  return `${result.grounded}\n`;
}

export async function runGroundednessCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const { json, flags } = parseArgs(rest, ["--context", "--answer"]);
  const contextFlag = flags["--context"];
  const answerFlag = flags["--answer"];

  if (!contextFlag) {
    process.stderr.write("upstage groundedness: missing required --context <text|@file> flag\n");
    return 2;
  }
  if (!answerFlag) {
    process.stderr.write("upstage groundedness: missing required --answer <text|@file> flag\n");
    return 2;
  }

  let context;
  let answer;
  try {
    context = resolveTextOrFile(contextFlag);
    answer = resolveTextOrFile(answerFlag);
  } catch (err) {
    process.stderr.write(`upstage groundedness: ${err.message}\n`);
    return 2;
  }

  if (!hasApiKey()) {
    process.stderr.write("upstage groundedness: UPSTAGE_API_KEY is not configured\n");
    return 4;
  }

  let result;
  try {
    result = await checkGroundedness({ context, answer });
  } catch (err) {
    process.stderr.write(`upstage groundedness: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodeForError(err, { fallbackCode: 1 });
  }

  process.stdout.write(json ? JSON.stringify(result) : formatHuman(result));
  return 0;
}
