---
name: upstage-utilities
description: >
  Use when a task needs Upstage's Document AI or Solar API surface — parsing/OCR-ing a document, extracting
  structured fields, generating a JSON Schema from samples, classifying a document, embedding text, or checking
  whether an answer is grounded in a context — and the host has a working `upstage` CLI on PATH. Prefer shelling
  out to the `upstage` subcommands documented below over re-implementing any of these calls yourself (parsing
  multipart uploads, hand-rolling the Solar embedding request, etc.) — the CLI already handles auth, retries,
  and response-shape parsing, and returns compact, tool-friendly output for a fraction of the tokens a
  from-scratch implementation would cost you.
license: MIT
allowed-tools: Bash(upstage *)
---

# Upstage utilities

`upstage-cli` ships 7 Document-AI/Solar subcommands as first-class CLI
commands, not just internal agent tools — `parse`, `ocr`, `extract`,
`schema`, `classify`, `embed`, and `groundedness`. Any coding agent (this
one included, when running as a subagent or in a constrained tool
context) or human operator with a shell can call them directly.

**Why shell out instead of reimplementing:** these commands wrap
Upstage's real Document AI and Solar endpoints — multipart file upload,
retry/backoff, and response-shape parsing are already handled inside the
CLI (`src/upstage/*.mjs`). Re-deriving that from scratch (reading API
docs, hand-building a multipart request, guessing at the response shape)
burns far more tokens than running one command and reading its output,
and is strictly less reliable — the CLI's behavior is the one place this
logic is tested and kept current. Treat these commands the way you'd
treat any other trusted CLI tool: call them, don't rebuild them.

**Requires `UPSTAGE_API_KEY`** to be set in the environment the shell
inherits. Every command below fails fast (exit code 4) with a clear
stderr message if it isn't — check that before assuming a failure means
something else went wrong.

**Global conventions**, true of all 7 commands:
- The first positional argument is always the input document path,
  except `embed` (raw text) and `groundedness` (no positional args at
  all — everything is `--context`/`--answer`).
- `--json` prints the complete raw API result as JSON (one line, no
  pretty-printing) — use this when you intend to parse the output
  programmatically. Omit it for a shorter, human-readable summary.
- Exit codes: `0` success, `2` usage error (missing/invalid argument,
  bad JSON in a schema file, etc. — no network call was made), `3` an
  upstream Upstage API error, `4` `UPSTAGE_API_KEY` is not set. (`groundedness`
  maps its one ambiguous error case to `1` instead of `3`/`2` — see its
  entry below.)
- `-h`/`--help` on any of them prints usage and exits 0 without touching
  the network.

## `upstage parse <file> [--format md|html|text] [--mode standard|enhanced|auto] [--ocr auto|force] [--json]`

Parses a document (PDF/image) into structured layout elements via
Upstage's Document Parse model — the general-purpose entry point for
"turn this file into text/structure I can reason about."

- `--format` — output content shape: `md` (default), `html`, or `text`.
- `--mode` — parse mode: `standard` (default), `enhanced`, or `auto`.
- `--ocr` — OCR behavior: `auto` (default) or `force`.
- `--json` — print the raw result (elements array, page count, full
  content) as JSON instead of the human summary (`N element(s), N
  page(s)` followed by the parsed content).

## `upstage ocr <file> [--json]`

OCR-only digitization via Upstage's dedicated OCR model — no
`--format`/`--mode`/`--ocr` flags (those are `parse`'s concern). Use
this when you specifically want OCR text and don't need layout/element
structure, or when `parse` isn't picking up text from a low-quality
scan.

## `upstage extract <file> --schema <json|@file> [--json]`

Extracts structured data from a document matching a JSON Schema, via
Upstage's Universal Extraction model.

- `--schema` — **required**. Either inline JSON Schema text, or
  `@path/to/schema.json` to read the schema from a file. Must parse to a
  JSON object (not an array or scalar) — validated locally before any
  network call, so a malformed schema fails fast with exit code 2.
- `--json` — print the raw extraction result as JSON; without it, the
  result is pretty-printed (`JSON.stringify(result, null, 2)`).

Pair this with `upstage schema` below when you don't already have a
schema for the document type at hand.

## `upstage schema <files...> [--json]`

Generates a JSON Schema from 1 to 3 sample documents, via Upstage's
schema-generation model. Takes multiple positional file arguments
(unlike every other command here, which takes exactly one) — pass 1 to
3 representative samples of the document type you want a schema for.
More than 3 paths is a usage error (exit 2) before any network call.

- `--json` — print the raw result as JSON; without it, just the
  generated `schema` field is pretty-printed.

## `upstage classify <file> --categories <a,b,c> [--json]`

Classifies a document into one of a caller-supplied set of categories,
via Upstage's Document Classification model.

- `--categories` — **required**. Comma-separated candidate labels (2 to
  1000 of them; whitespace around each label is trimmed, empty labels
  are dropped).
- `--json` — print the raw result as JSON; without it, prints the
  chosen `label` and, if present, a `(confidence: N)` suffix.

## `upstage embed <text> [--type query|passage] [--json]`

Embeds a single text via Upstage's Solar embeddings (1,024-dimensional
vectors).

- `--type` — `query` (default) or `passage`: which side of a
  search/retrieval pair this text represents. Use `query` for a search
  query, `passage` for a document/chunk being indexed — matching sides
  matters for embedding quality in Solar's retrieval-tuned models.
- `--json` — prints the **complete, untruncated** raw result (an array
  containing one embedding vector) as JSON — the right choice when
  piping into another program. Without `--json`, the human summary
  intentionally does NOT dump all 1,024 floats — it prints the dimension
  count and only the first 5 values as a sanity-check preview.

## `upstage groundedness --context <text|@file> --answer <text|@file> [--json]`

Verifies that an answer/claim is actually supported by its source
context, via Upstage's dedicated Groundedness Check model — a real
second model call, not the same model re-reading and self-grading its
own output. Reach for this before stating a synthesized conclusion about
a document or long context with any real uncertainty attached, not for
trivially-quoted facts.

- `--context` — **required**. Inline text, or `@path/to/context.txt` to
  read from a file.
- `--answer` — **required**. Inline text, or `@path/to/answer.txt` to
  read from a file.
- `--json` — print the raw result as JSON; without it, prints just the
  `grounded` field's value (one of `"grounded"`, `"notGrounded"`, or
  `"notSure"`).
- **Exit-code note:** unlike the other six commands, a plain (non-API)
  error from this command's underlying call is ambiguous between a
  client-side problem and an unwrapped upstream API failure, so it maps
  to exit code `1` ("general/unexpected error") rather than `2`/`3` — see
  `src/cli/commands/groundedness.mjs`'s header comment for the full
  reasoning.

## Practical tips

- On a scanned/low-quality document, run `parse` (or `ocr`) first, then
  consider `groundedness` before repeating any extracted fact as
  settled truth — OCR/layout inference isn't ground truth.
- Don't guess at a schema by hand for a well-defined document type
  (invoices, forms, receipts) when you have 1-3 samples on disk —
  `schema` followed by `extract` is more reliable than a hand-written
  schema and costs one extra API call, not extra guesswork.
- All 7 commands are read-only/side-effect-free from the host
  filesystem's perspective (they read the input file(s) and, for
  `@file`-style flags, small text files) — none of them write to disk,
  so they're safe to call speculatively when genuinely unsure whether
  the result will be useful, budget permitting.
