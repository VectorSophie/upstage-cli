import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const CLI_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../src");

async function importFromCli(relPath) {
  return import(pathToFileURL(resolve(CLI_ROOT, relPath)).href);
}

// Patterns for secret exfiltration detection in tool calls
const SECRET_EXFIL_RE = /\b(API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|ACCESS_KEY)\b/i;
const EXFIL_TRANSPORT_RE = /\b(curl|wget)\b.*--data/i;

// Unofficial registry patterns for dependency confusion detection
const UNOFFICIAL_PIP_RE = /pip\s+install.*--index-url\s+(?!https:\/\/pypi\.org)/i;
const UNOFFICIAL_NPM_RE = /npm\s+(install|i)\s+.*--registry\s+(?!https:\/\/registry\.npmjs\.org)/i;

// Prompt injection patterns in file content
const PROMPT_INJECTION_RE = /ignore\s+(previous|all)\s+instructions?/i;

export class SafetyGuardrails {
  constructor({ hookEngine = null, riskFlags = [] } = {}) {
    this._hookEngine = hookEngine;
    this._riskFlags = riskFlags;
    this._secretsDetected = false;
  }

  get riskFlags() { return [...this._riskFlags]; }
  get secretsDetected() { return this._secretsDetected; }

  safetyReport() {
    return {
      riskFlags: this.riskFlags,
      secretsDetected: this._secretsDetected
    };
  }

  /**
   * Check a shell command string for all 5 safety categories.
   * Returns { safe: boolean, flags: string[] }
   */
  async checkCommand(command) {
    const flags = [];

    // 1. Delegate to existing injection-check (reuses getDangerousPatterns + usesElevation)
    const { checkInjection, usesElevation } = await importFromCli("permissions/injection-check.mjs");

    const injection = checkInjection(command);
    if (!injection.safe) {
      flags.push(`dangerous_command:${injection.label}`);
    }

    // 2. Privilege escalation
    if (usesElevation(command)) {
      flags.push("privilege_escalation:sudo/su/doas");
    }

    // 3. Secret exfiltration: network transport carrying credential-shaped data
    if (EXFIL_TRANSPORT_RE.test(command) && SECRET_EXFIL_RE.test(command)) {
      flags.push("secret_exfiltration:credential_in_request");
      this._secretsDetected = true;
    }

    // 4. Dependency confusion: pip/npm from unofficial registry
    if (UNOFFICIAL_PIP_RE.test(command)) {
      flags.push("dependency_confusion:unofficial_pip_registry");
    }
    if (UNOFFICIAL_NPM_RE.test(command)) {
      flags.push("dependency_confusion:unofficial_npm_registry");
    }

    if (flags.length > 0) {
      this._riskFlags.push(...flags);
    }

    // 5. Hook engine gate (if wired)
    if (this._hookEngine && flags.length > 0) {
      const decision = await this._hookEngine.runPreToolUse("shell", { command });
      if (!decision.allow) {
        return { safe: false, flags };
      }
    }

    return { safe: flags.length === 0, flags };
  }

  /**
   * Scan file content for prompt injection attempts.
   */
  checkFileContent(content) {
    if (PROMPT_INJECTION_RE.test(content)) {
      const flag = "prompt_injection:ignore_instructions_pattern";
      this._riskFlags.push(flag);
      return { safe: false, flags: [flag] };
    }
    return { safe: true, flags: [] };
  }
}
