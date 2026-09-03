import { resolve, sep } from "node:path";
import { scanKoreanPII, summarizeFindings } from "../../permissions/korean-pii-check.mjs";

const DEFAULT_ACTION_CLASS_BY_RISK = {
  low: "read",
  medium: "exec",
  high: "write"
};

const SECURITY_OVERRIDE_ENV = "SECURITY_OVERRIDE";
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

const DEFAULT_RULES = {
  read: { allow: true, requiresConfirmation: false },
  write: { allow: true, requiresConfirmation: true },
  exec: { allow: true, requiresConfirmation: true },
  network: { allow: true, requiresConfirmation: true },
  git: { allow: true, requiresConfirmation: true },
  publish: { allow: false, requiresConfirmation: true }
};

function normalizeTrustedWritePaths(inputPaths) {
  const candidatePaths =
    Array.isArray(inputPaths) && inputPaths.length > 0 ? inputPaths : [process.cwd()];
  const normalized = new Set();

  for (const candidatePath of candidatePaths) {
    if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
      continue;
    }
    normalized.add(resolve(candidatePath));
  }

  if (normalized.size === 0) {
    normalized.add(resolve(process.cwd()));
  }

  return Array.from(normalized);
}

function normalizePathForComparison(pathValue) {
  const resolvedPath = resolve(pathValue);
  if (process.platform === "win32") {
    return resolvedPath.toLowerCase();
  }
  return resolvedPath;
}

function isWithinTrustedRoot(absolutePath, trustedRoot) {
  if (absolutePath === trustedRoot) {
    return true;
  }
  const trustedRootWithSeparator = trustedRoot.endsWith(sep)
    ? trustedRoot
    : `${trustedRoot}${sep}`;
  return absolutePath.startsWith(trustedRootWithSeparator);
}

function flattenArgStrings(args, depth = 0) {
  if (depth > 3 || args === null || typeof args === "undefined") return "";
  if (typeof args === "string") return args;
  if (Array.isArray(args)) return args.map((v) => flattenArgStrings(v, depth + 1)).join("\n");
  if (typeof args === "object") return Object.values(args).map((v) => flattenArgStrings(v, depth + 1)).join("\n");
  return "";
}

function isSecurityOverrideEnabled() {
  const rawValue = process.env[SECURITY_OVERRIDE_ENV];
  if (typeof rawValue !== "string") {
    return false;
  }
  return TRUTHY_ENV_VALUES.has(rawValue.trim().toLowerCase());
}

export class PolicyEngine {
  constructor(config = {}) {
    this.allowHighRiskTools = config.allowHighRiskTools === true;
    this.requireConfirmationForHighRisk =
      config.requireConfirmationForHighRisk !== false;
    this.trustedWritePaths = normalizeTrustedWritePaths(config.trustedWritePaths);
    this.rules = {
      ...DEFAULT_RULES,
      ...(config.rules || {})
    };
  }

  getActionClass(tool) {
    if (tool && typeof tool.actionClass === "string" && tool.actionClass.length > 0) {
      return tool.actionClass;
    }
    const risk = tool?.risk || "low";
    return DEFAULT_ACTION_CLASS_BY_RISK[risk] || "exec";
  }

  getTrustedWritePaths(context = {}) {
    if (Array.isArray(context.trustedWritePaths) && context.trustedWritePaths.length > 0) {
      return normalizeTrustedWritePaths(context.trustedWritePaths);
    }
    return this.trustedWritePaths;
  }

  evaluateWritePath(requestedPath, context = {}) {
    const basePath =
      typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();
    const absolutePath = resolve(basePath, requestedPath);
    const trustedPaths = this.getTrustedWritePaths(context);

    if (isSecurityOverrideEnabled()) {
      return {
        allowed: true,
        reason: "security_override",
        errorCode: null,
        details: {
          requestedPath,
          absolutePath,
          trustedPaths,
          securityOverride: true,
          securityOverrideEnv: SECURITY_OVERRIDE_ENV
        }
      };
    }

    const normalizedTargetPath = normalizePathForComparison(absolutePath);
    const allowed = trustedPaths
      .map((trustedPath) => normalizePathForComparison(trustedPath))
      .some((trustedPath) => isWithinTrustedRoot(normalizedTargetPath, trustedPath));

    if (!allowed) {
      return {
        allowed: false,
        reason: "write_path_outside_trusted_paths",
        errorCode: "POLICY_VIOLATION",
        details: {
          requestedPath,
          absolutePath,
          trustedPaths,
          securityOverride: false,
          securityOverrideEnv: SECURITY_OVERRIDE_ENV
        }
      };
    }

    return {
      allowed: true,
      reason: "write_path_allowed",
      errorCode: null,
      details: {
        requestedPath,
        absolutePath,
        trustedPaths,
        securityOverride: false,
        securityOverrideEnv: SECURITY_OVERRIDE_ENV
      }
    };
  }

  evaluate(tool, args, context = {}) {
    const actionClass = this.getActionClass(tool);
    const rule = this.rules[actionClass] || { allow: true, requiresConfirmation: false };

    if (tool?.risk === "high" && !this.allowHighRiskTools) {
      return {
        allowed: false,
        reason: "high_risk_disabled",
        actionClass,
        requiresConfirmation: false,
        details: { tool: tool?.name, args, policy: "allowHighRiskTools=false" }
      };
    }

    if (!rule.allow) {
      return {
        allowed: false,
        reason: "action_class_blocked",
        actionClass,
        requiresConfirmation: false,
        details: { tool: tool?.name, args, policy: `rule:${actionClass}` }
      };
    }

    // Korean PII guardrail (docs/feature-landscape-2026.md §2.1): scan
    // write/network calls for RRN/business-registration/card/phone
    // patterns and force a confirmation gate — redact-or-block-outright
    // would be too aggressive for legitimate cases (test fixtures, docs
    // with masked examples), so this surfaces it for a human decision
    // rather than silently mutating or refusing the write.
    const piiFindings = (actionClass === "write" || actionClass === "network")
      ? scanKoreanPII(flattenArgStrings(args))
      : [];
    // §2.3 PIPA awareness: same detector, but named distinctly when the
    // action class is "network" specifically — Korean personal data about
    // to leave the machine is a materially different risk (PIPA Article
    // 28-8 cross-border transfer) than data merely being written to a
    // local file, even though the underlying pattern match is identical.
    const pipaWarning = actionClass === "network" && piiFindings.some((f) => f.verified);

    const requiresConfirmation =
      rule.requiresConfirmation ||
      (tool?.risk === "high" && this.requireConfirmationForHighRisk) ||
      piiFindings.length > 0;

    return {
      allowed: true,
      reason: "allowed",
      actionClass,
      requiresConfirmation,
      details: {
        tool: tool?.name,
        args,
        policy: requiresConfirmation ? "confirmation_required" : "allowed_without_confirmation",
        cwd: context.cwd || null,
        pii: piiFindings.length > 0
          ? { findings: piiFindings, counts: summarizeFindings(piiFindings), pipaWarning }
          : null
      }
    };
  }
}
