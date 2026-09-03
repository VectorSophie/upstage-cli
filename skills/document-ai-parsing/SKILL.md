---
name: document-ai-parsing
description: >
  Use when a user shares or references a file the read_file tool can't handle as text — a scanned/photographed
  PDF, a screenshot of an error dialog, a photo of a whiteboard or design spec, a scanned contract — instead of
  giving up or guessing at the content. Calls Upstage's real Document AI (OCR + Layout Analysis), strong on
  Korean text and complex layouts (tables, figures), not a generic OCR wrapper.
license: MIT
---

# Document AI parsing

The `read_document` tool sends a PDF/PNG/JPEG/TIFF/HEIC file to Upstage's
`document-digitization` endpoint and returns structured Markdown — one
concatenated document built from per-element OCR + layout results
(tables, figures, and body text detected and ordered correctly), not a
flat OCR text dump.

**When this skill applies:**
- `read_file` fails or returns binary garbage on a `.pdf`/image path —
  don't retry `read_file` differently or tell the user you can't read it;
  reach for `read_document` instead.
- A user pastes a screenshot path of a stack trace, a design mock, or a
  whiteboard photo and asks a question about its contents.
- A scanned contract, invoice, or form needs specific fields extracted —
  the returned Markdown preserves table structure well enough to quote
  specific cells accurately.

**Limits to respect:**
- 20MB file size cap — if a file exceeds this, say so rather than
  silently truncating or retrying.
- Costs a real API call (network, `UPSTAGE_API_KEY` required) — don't
  call it speculatively on every file in a directory; use it when a
  specific file's content is actually needed.
- The output is OCR/layout-inferred, not ground truth — for anything
  where getting it wrong matters (a number on a scanned invoice, a legal
  clause), consider `check_groundedness` before asserting the extracted
  content as fact, especially on lower-quality scans/photos.
