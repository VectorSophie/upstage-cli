---
name: semantic-code-search
description: >
  Use when grep/glob/search_code come up empty or thin on a query that should plausibly have a match — the
  code likely uses different wording, Korean identifiers/comments, or a synonym the keyword search can't catch.
  Ranks candidates you've already gathered by meaning, using Upstage's Korean-optimized Solar embeddings — not
  a replacement for grep, a fallback for when grep's exact-match limitation is the actual problem.
license: MIT
---

# Semantic code search

`semantic_search` doesn't crawl the repo itself — gather a set of
candidate snippets first (grep for loose keywords, glob likely files, or
just read a handful of files fully), then rank them against a natural-
language query using real embeddings (Solar's `-query`/`-passage` models),
not string matching.

**When this skill applies:**
- A keyword search for an English term returns nothing, but the
  codebase's comments/identifiers are in Korean (or vice versa) — grep
  for a loose superset of candidates, then let semantic ranking find the
  actual match among them.
- The user describes what they want in a paraphrase ("where do we check
  if someone's allowed to do this") rather than a literal identifier —
  grep has no string to anchor on; semantic ranking does.
- A first grep pass returns 40+ weak hits and you need to prioritize
  which few are actually worth reading in full.

**When it doesn't apply:** if you already know the exact symbol/string
to search for, `grep`/`search_code`/`find_symbol` are cheaper (no API
call, no embedding cost) and more precise — don't reach for this as a
default first move. This is specifically for the gap where keyword
search's exact-match nature is the actual obstacle.

**Workflow:** gather candidates (grep/glob/read_file) → pass them as
`candidates` with the natural-language `query` → read the top-ranked
results in full before concluding anything, since a high similarity
score is a ranking signal, not proof of relevance.
