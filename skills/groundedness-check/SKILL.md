---
name: groundedness-check
description: >
  Use before presenting a summary, explanation, or factual claim about content you retrieved or read (a file,
  a web page, search results, a long document) when you're not fully certain the claim is actually supported —
  calls Upstage's real Groundedness Check model instead of self-grading, and is cheaper than being wrong.
license: MIT
---

# Groundedness check

The `check_groundedness` tool sends `(context, answer)` to a dedicated
Upstage verification model (`solar-1-mini-answer-verification`) and
returns `"grounded"`, `"notGrounded"`, or `"notSure"` — a second,
independent judgment, not the same model re-reading its own output.

**When this skill applies:**
- Summarizing a long file, PR diff, or search result before stating a
  factual conclusion drawn from it ("this function handles retries" —
  verify that against the actual read content first if there's any
  ambiguity in a large file).
- Answering "does X do Y" questions about a codebase you've only
  partially read.
- After `read_document` (scanned/PDF input) — OCR and layout parsing can
  introduce content that isn't in the original; check materially
  important claims before repeating them as fact.

**When it doesn't apply:** trivial, directly-quoted facts ("line 42 says
X" when you just read line 42) don't need verification — this is for
claims that involved synthesis, not direct quotation. Don't call it on
every sentence; that defeats its cost/latency tradeoff.

If the result is `notGrounded` or `notSure`, say so explicitly to the
user rather than presenting the original claim with more confidence than
it deserves — matches the CRITICAL verify/never-fabricate rule already in
the system prompt.
