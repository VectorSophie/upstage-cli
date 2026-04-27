import { execSync } from "node:child_process";

export async function runCheck(check, workdir, defaultTimeout = 120) {
  const timeout = (check.timeout || defaultTimeout) * 1000;
  const start = Date.now();

  try {
    execSync(check.command, {
      cwd: workdir,
      timeout,
      stdio: "pipe"
    });
    const durationMs = Date.now() - start;
    return {
      id: check.id,
      passed: true,
      exitCode: 0,
      durationMs,
      stdout: "",
      stderr: "",
      weight: check.weight ?? 1.0,
      required: check.required !== false
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const stdout = err.stdout ? err.stdout.toString("utf8") : "";
    const stderr = err.stderr ? err.stderr.toString("utf8") : "";
    const exitCode = typeof err.status === "number" ? err.status : 1;
    return {
      id: check.id,
      passed: false,
      exitCode,
      durationMs,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000),
      weight: check.weight ?? 1.0,
      required: check.required !== false
    };
  }
}

export async function runAll(checks, workdir, defaultTimeout = 120) {
  const results = [];
  for (const check of checks) {
    const result = await runCheck(check, workdir, defaultTimeout);
    results.push(result);
  }
  return results;
}

export function failToPassRate(results) {
  if (!results || results.length === 0) return 1.0;
  const passed = results.filter((r) => r.passed).length;
  return passed / results.length;
}

export function passToPassRate(results) {
  if (!results || results.length === 0) return 1.0;
  const passed = results.filter((r) => r.passed).length;
  return passed / results.length;
}
