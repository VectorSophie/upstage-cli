export class Sandbox {
  constructor(platform) {
    this.platform = platform || process.platform;
  }

  wrapCommand(command, options = {}) {
    if (this.platform === "linux") return this.bubblewrap(command, options);
    if (this.platform === "darwin") return this.seatbelt(command, options);
    return command;
  }

  bubblewrap(command, opts = {}) {
    const args = [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
    ];

    if (opts.allowWrite) {
      for (const dir of opts.allowWrite) {
        if (typeof dir === "string" && dir.length > 0) {
          args.push("--bind", dir, dir);
        }
      }
    }

    if (opts.allowDevices) {
      args.push("--dev-bind", "/dev", "/dev");
    }

    return `bwrap ${args.join(" ")} -- ${command}`;
  }

  seatbelt(command, opts = {}) {
    const rules = [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow file-read*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
    ];

    if (opts.allowWrite) {
      for (const dir of opts.allowWrite) {
        if (typeof dir === "string" && dir.length > 0) {
          rules.push(`(allow file-write* (subpath "${dir}"))`);
        }
      }
    }

    rules.push('(allow file-write* (subpath "/tmp"))');

    if (opts.allowNet) {
      rules.push("(allow network*)");
    }

    const profile = rules.join("\n");
    const escaped = profile.replace(/'/g, "'\\''");
    return `sandbox-exec -p '${escaped}' ${command}`;
  }

  check() {
    if (this.platform === "linux") {
      return { available: true, tool: "bwrap" };
    }
    if (this.platform === "darwin") {
      return { available: true, tool: "sandbox-exec" };
    }
    return { available: false, tool: "none" };
  }
}
