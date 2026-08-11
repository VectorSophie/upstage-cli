/**
 * Korean-specific PII detection — the concrete gap found in
 * docs/feature-landscape-2026.md §2.1: mainstream guardrail products
 * (AWS Bedrock Guardrails etc.) ship English-first PII rulesets that miss
 * identifiers that only exist in Korea — 주민등록번호 (resident registration
 * number), 사업자등록번호 (business registration number) — entirely, or
 * shape-match them without verifying the checksum (which both numbers
 * carry), producing false positives on any 13-digit string that merely
 * looks like an RRN. This validates the actual checksum algorithms, not
 * just the shape.
 */

// RRN: YYMMDD-XZZZZZZ. The 13th digit is a checksum over the first 12,
// weights [2,3,4,5,6,7,8,9,2,3,4,5], per the standard published algorithm.
const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
const RRN_PATTERN = /\b(\d{6})-?([1-4]\d{6})\b/g;

function isValidRrn(digits13) {
  const d = digits13.split("").map(Number);
  const sum = RRN_WEIGHTS.reduce((acc, w, i) => acc + w * d[i], 0);
  const check = (11 - (sum % 11)) % 10;
  return check === d[12];
}

// Business registration number: XXX-XX-XXXXX (10 digits), its own
// documented checksum — weights [1,3,7,1,3,7,1,3,5] over the first 9
// digits, plus a carry term on the 9th digit.
const BIZ_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];
const BIZ_REG_PATTERN = /\b(\d{3})-?(\d{2})-?(\d{5})\b/g;

function isValidBizReg(digits10) {
  const d = digits10.split("").map(Number);
  let sum = BIZ_WEIGHTS.reduce((acc, w, i) => acc + w * d[i], 0);
  sum += Math.floor((d[8] * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === d[9];
}

// Card numbers — standard Luhn checksum, not Korea-specific but a common
// companion to RRN/business-number leaks in the same fixtures/logs.
const CARD_PATTERN = /\b(?:\d[ -]?){13,16}\b/g;

function isValidLuhn(digitsOnly) {
  let sum = 0;
  let alternate = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let n = Number(digitsOnly[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// Korean mobile phone numbers — shape only (no checksum exists for these),
// same tier real guardrail products treat as "detected, not verified."
const PHONE_PATTERN = /\b01[016789]-?\d{3,4}-?\d{4}\b/g;

function maskMiddle(value, keepStart = 2, keepEnd = 0) {
  const visible = value.length - keepStart - keepEnd;
  if (visible <= 0) return value;
  return value.slice(0, keepStart) + "*".repeat(visible) + (keepEnd > 0 ? value.slice(-keepEnd) : "");
}

/**
 * Scan text for Korean-specific PII patterns. Returns findings with a
 * `verified` flag — true when the actual checksum passed (high
 * confidence), false when only the shape matched (still worth a warning,
 * lower confidence — e.g. a 13-digit string that isn't a real RRN).
 */
export function scanKoreanPII(text) {
  if (typeof text !== "string" || !text) return [];
  const findings = [];

  for (const m of text.matchAll(RRN_PATTERN)) {
    const digits = `${m[1]}${m[2]}`;
    findings.push({
      type: "rrn",
      match: m[0],
      masked: maskMiddle(m[0], 6),
      verified: isValidRrn(digits)
    });
  }

  for (const m of text.matchAll(BIZ_REG_PATTERN)) {
    const digits = `${m[1]}${m[2]}${m[3]}`;
    findings.push({
      type: "bizReg",
      match: m[0],
      masked: maskMiddle(m[0], 3),
      verified: isValidBizReg(digits)
    });
  }

  for (const m of text.matchAll(CARD_PATTERN)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 16) continue;
    if (!isValidLuhn(digits)) continue; // shape-only card numbers are too noisy to warn on
    findings.push({ type: "card", match: m[0], masked: maskMiddle(m[0], 4, 4), verified: true });
  }

  for (const m of text.matchAll(PHONE_PATTERN)) {
    findings.push({ type: "phone", match: m[0], masked: maskMiddle(m[0], 3), verified: false });
  }

  return findings;
}

/** Redact all detected PII in `text`, replacing each match with its masked form. */
export function redactKoreanPII(text) {
  const findings = scanKoreanPII(text);
  let out = text;
  for (const f of findings) {
    out = out.split(f.match).join(f.masked);
  }
  return out;
}

export function summarizeFindings(findings) {
  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  return counts;
}
