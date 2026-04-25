import { resolve, basename, sep } from "node:path";

const SENSITIVE_PATTERNS = [
  /\.env$/,
  /\.env\..+$/,
  /credentials\.json$/,
  /credentials\.yaml$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa$/,
  /id_ed25519$/,
  /\.ssh\/config$/,
  /\.netrc$/,
  /\.pgpass$/,
  /\.aws\/credentials$/,
  /\.docker\/config\.json$/,
  /secrets\.yaml$/,
  /secrets\.json$/,
  /\.npmrc$/,
  /\.pypirc$/,
];

const PROTECTED_DIRS_WIN = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
];

const PROTECTED_DIRS_POSIX = [
  "/etc",
  "/usr",
  "/sbin",
  "/boot",
  "/sys",
  "/proc",
];

function getProtectedDirs() {
  return process.platform === "win32" ? PROTECTED_DIRS_WIN : PROTECTED_DIRS_POSIX;
}

export function validatePath(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return { safe: false, resolved: "", reason: "Empty or invalid path" };
  }

  if (filePath.includes("\0")) {
    return { safe: false, resolved: "", reason: "Null byte in path" };
  }

  const resolved = resolve(filePath);
  const cwd = options.cwd || process.cwd();

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(resolved) || pattern.test(basename(resolved))) {
      return { safe: false, resolved, reason: "Sensitive file" };
    }
  }

  if (options.write) {
    const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    for (const dir of getProtectedDirs()) {
      const normalizedDir = process.platform === "win32" ? dir.toLowerCase() : dir;
      if (normalizedResolved.startsWith(normalizedDir + sep) || normalizedResolved === normalizedDir) {
        return { safe: false, resolved, reason: `Protected directory: ${dir}` };
      }
    }
  }

  let warning;
  if (!resolved.startsWith(cwd) && !resolved.startsWith(sep + "tmp") && !resolved.startsWith(sep + "var" + sep + "tmp")) {
    warning = "Path is outside the current working directory";
  }

  return { safe: true, resolved, warning };
}

export function isSensitiveFile(filename) {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(filename)) return true;
  }
  return false;
}

export function getSensitivePatterns() {
  return [...SENSITIVE_PATTERNS];
}
