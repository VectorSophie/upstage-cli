const DANGEROUS_PATTERNS = [
  { pattern: /;\s*rm\s+-rf\s+\//, label: "rm -rf /" },
  { pattern: /\brm\s+-rf\s+[/\\]\s*$/, label: "rm -rf root" },
  { pattern: /\|\s*sh\b/, label: "pipe to sh" },
  { pattern: /\|\s*bash\b/, label: "pipe to bash" },
  { pattern: /`[^`]+`/, label: "backtick execution" },
  { pattern: /\$\([^)]+\)/, label: "command substitution" },
  { pattern: />\s*\/etc\//, label: "write to /etc" },
  { pattern: />\s*\/usr\//, label: "write to /usr" },
  { pattern: /curl\s.*\|\s*(bash|sh)/, label: "curl pipe to shell" },
  { pattern: /wget\s.*\|\s*(bash|sh)/, label: "wget pipe to shell" },
  { pattern: /mkfs\./, label: "filesystem format" },
  { pattern: /dd\s+if=.*of=\/dev\//, label: "dd to device" },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, label: "fork bomb" },
  { pattern: /chmod\s+777\s+\//, label: "chmod 777 root" },
  { pattern: />\s*\/dev\/sda/, label: "write to disk device" },
  { pattern: /eval\s+"?\$/, label: "eval variable" },
  { pattern: /\biex\b.*\|/, label: "iex pipe (PowerShell)" },
  { pattern: /Invoke-Expression/, label: "Invoke-Expression (PowerShell)" },
  { pattern: /Remove-Item\s+-Recurse\s+-Force\s+\\/, label: "Remove-Item force root (PowerShell)" },
  { pattern: /Format-Volume/, label: "Format-Volume (PowerShell)" },
];

export function checkInjection(command) {
  if (typeof command !== "string") {
    return { safe: false, label: "non-string command" };
  }

  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, pattern: pattern.source, label };
    }
  }

  return { safe: true };
}

export function usesElevation(command) {
  return /\bsudo\b/.test(command) || /\bsu\s+-?\s/.test(command) || /\bdoas\b/.test(command) || /\bRunAs\b/.test(command);
}

export function getDangerousPatterns() {
  return DANGEROUS_PATTERNS.map(({ pattern, label }) => ({ pattern, label }));
}
