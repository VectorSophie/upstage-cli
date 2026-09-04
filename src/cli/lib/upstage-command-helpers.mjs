// Shared plumbing for the seven Document-AI CLI commands (Task 7.8 of the
// 3.2.0 release plan — parse/ocr/extract/schema/classify/embed/groundedness).
//
// CODE-SHARING DECISION: these seven command files share exactly four small,
// genuinely cross-cutting concerns — argv parsing (flags/positionals),
// `--json` detection, the `@file` inline-text-or-file-path convention (used
// by extract's `--schema` and groundedness's `--context`/`--answer`), the
// `UPSTAGE_API_KEY`-presence check, and the UpstageApiError-vs-plain-Error
// exit-code mapping. Factoring these four into one small helper module (this
// file) avoids five-to-seven-fold duplication of genuinely identical logic,
// while each command file still owns 100% of its OWN flag set, its own
// required-arg validation messages, and its own result formatting — nothing
// command-specific leaks in here. This mirrors the precedent already set by
// `src/cli/lib/command-detection.mjs` and `src/cli/lib/install-type.mjs`
// (small single-purpose helpers shared by doctor.mjs and others), rather than
// inventing a new sharing convention for this task.
import { readFileSync } from "node:fs";
import { UpstageApiError } from "../../upstage/errors.mjs";

/**
 * Minimal argv splitter: recognizes `--json` (boolean), any flag name listed
 * in `valueFlags` (consumes the following token as its value), and treats
 * everything else as a positional. This is intentionally tiny — no
 * `--flag=value` support, no short flags — because every one of these seven
 * commands' flag sets (per the plan's §6) is this simple; a general-purpose
 * parser would be more machinery than the surface it's parsing.
 *
 * @param {string[]} argv
 * @param {string[]} [valueFlags] - flag tokens (e.g. "--format") that consume
 *   the next argv token as their value.
 * @returns {{ json: boolean, flags: Record<string, string>, positionals: string[] }}
 */
export function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positionals = [];
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      json = true;
    } else if (valueFlags.includes(token)) {
      flags[token] = argv[i + 1];
      i += 1;
    } else {
      positionals.push(token);
    }
  }

  return { json, flags, positionals };
}

/**
 * Resolves the `<text|@file>` convention used by extract's `--schema` and
 * groundedness's `--context`/`--answer`: a value starting with `@` is a
 * file path to read from (UTF-8); anything else is used literally.
 *
 * @param {string} value
 * @returns {string} the literal value, or the referenced file's contents.
 * @throws {Error} if the value is `@`-prefixed and the file can't be read —
 *   callers should treat this as a usage error (exit 2), not surface the raw
 *   fs error message.
 */
export function resolveTextOrFile(value) {
  if (typeof value === "string" && value.startsWith("@")) {
    const filePath = value.slice(1);
    try {
      return readFileSync(filePath, "utf8");
    } catch (err) {
      throw new Error(`could not read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return value;
}

/** True when `UPSTAGE_API_KEY` is set (matches client.mjs/upstage-adapter.mjs's own resolution). */
export function hasApiKey() {
  return Boolean(process.env.UPSTAGE_API_KEY);
}

/**
 * Maps an error thrown by a `src/upstage/*.mjs` call to an exit code, per the
 * plan's §6 exit-code table:
 *   - `UpstageApiError` (thrown by `upstageRequest` on a non-2xx response or
 *     a network-level failure — see client.mjs) -> 3, "upstream Upstage API
 *     error."
 *   - anything else -> `fallbackCode`.
 *
 * EXIT-CODE MAPPING DECISION for the fallback: for six of these seven
 * commands (parse/ocr/extract/schema/classify/embed — everything routed
 * through `upstageRequest`/client.mjs), a plain (non-`UpstageApiError`) throw
 * from the underlying service function is EITHER client-side validation
 * performed before any network call (bad file path/type/size, invalid
 * `type`/categories count, too many schema-sample paths, ...) — the common
 * case — OR, rarely, a post-2xx response-shape mismatch: extraction.mjs's
 * `extractStructured`/`generateSchema`, classification.mjs, and
 * embeddings.mjs each also throw a plain `Error("...unexpected response
 * shape")` AFTER a successful round-trip, if Upstage's real response doesn't
 * match this repo's synthetic-tool-call shape assumption (documented as
 * not-yet-live-verified in each of those modules' headers). That second case
 * genuinely isn't a usage mistake, but `client.mjs`'s `upstageRequest` has no
 * way to distinguish it from client-side validation from the outside either
 * — both surface as the same plain `Error` shape. Mapping the fallback to
 * exit 2 is therefore a deliberately accepted approximation (right far more
 * often than not) rather than a confirmed classification; it should be
 * revisited once a future task live-verifies these three modules' actual
 * response shapes against the real API and can tell the two cases apart
 * properly (e.g. by having them throw `UpstageApiError` for a genuine
 * shape-mismatch instead of a plain `Error`) rather than continuing to guess.
 * Their command files call this with the default `fallbackCode: 2` in the
 * meantime.
 *
 * `groundedness` is the deliberate exception: `checkGroundedness()` calls
 * `UpstageAdapter.complete()` directly (see groundedness.mjs's own header for
 * why), which throws a plain `Error` for BOTH client-side validation AND
 * genuine upstream API failures (`Upstage API error (500): ...`) alike —
 * there is no reliable way to tell those apart from the outside without
 * fragile message-sniffing. Since the groundedness command file already
 * validates `--context`/`--answer` presence and the API key itself before
 * ever calling `checkGroundedness()`, whatever plain Error still reaches this
 * mapping is most likely a genuine (if unwrapped) API-adjacent failure, not a
 * usage mistake — so groundedness.mjs calls this with `fallbackCode: 1`
 * ("general/unexpected error") instead of the default 2. See
 * groundedness.mjs for where this is wired.
 */
export function exitCodeForError(err, { fallbackCode = 2 } = {}) {
  if (err instanceof UpstageApiError) return 3;
  return fallbackCode;
}
