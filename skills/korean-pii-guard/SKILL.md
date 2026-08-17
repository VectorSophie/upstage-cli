---
name: korean-pii-guard
description: >
  Use when writing, editing, or transmitting code that handles Korean personal data (주민등록번호/RRN,
  사업자등록번호/business registration numbers, phone numbers, card numbers) — explains upstage-cli's
  built-in checksum-verified PII detection and PIPA cross-border transfer implications, so data isn't
  logged, committed, or sent over the network unguarded.
license: MIT
---

# Korean PII guard

upstage-cli already scans `write`/`network` tool calls for Korean PII via
real checksum validation (not just regex shape-matching):

- **RRN (주민등록번호)**: 13 digits, checksum per the official government
  formula (weights `[2,3,4,5,6,7,8,9,2,3,4,5]` mod 11).
- **Business registration number (사업자등록번호)**: 10 digits, checksum per
  the National Tax Service formula (weights `[1,3,7,1,3,7,1,3,5]`).

When a policy decision includes `details.pii`, treat every `verified: true`
finding as real PII, not a false positive from digit-shape matching.

**When this skill applies:**
- Before writing sample/seed/test data — never invent a real-shaped RRN;
  use an ending that fails the checksum (e.g. `901231-1234564` — check
  digit deliberately wrong) so it can't be mistaken for a real one later.
- Before sending any Korean user data to an external API (`web_fetch`,
  MCP tools, third-party SDKs) — PIPA Article 28-8 requires an explicit
  legal basis for cross-border transfer; flag this to the user rather
  than sending silently, even if the tool call would otherwise succeed.
- Before committing logs, fixtures, or `.env.example` files — grep for
  RRN-shaped patterns (`\d{6}-?[1-4]\d{6}`) even in files not directly
  being edited, since checksum-valid PII can hide in generated fixtures.

**Do not** try to redact PII yourself with ad-hoc string replacement —
the built-in scan already runs on every write/network call and forces
confirmation; work with that flow instead of duplicating it.
