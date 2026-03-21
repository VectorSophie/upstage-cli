import { runSandboxedProcess } from "../../sandbox/exec.js";

async function runGhJson(args, context) {
  const result = await runSandboxedProcess("gh", args, {
    cwd: context.cwd,
    timeoutMs: 120000,
    outputLimit: 120000,
    networkBlocked: false,
    onStdout: (text) => context.onLog?.({ stage: "gh", channel: "stdout", text }),
    onStderr: (text) => context.onLog?.({ stage: "gh", channel: "stderr", text })
  });
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "gh command failed");
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { raw: result.stdout };
  }
}

export const ghIssueReadTool = {
  name: "gh_issue_read",
  description: "Read a GitHub issue by number using gh CLI",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number" },
      repo: { type: "string" }
    },
    required: ["number"],
    additionalProperties: false
  },
  async execute(args, context) {
    const fields = "number,title,body,state,author,labels,comments";
    const baseArgs = ["issue", "view", String(args.number), "--json", fields];
    if (typeof args.repo === "string" && args.repo.length > 0) {
      baseArgs.push("--repo", args.repo);
    }
    return runGhJson(baseArgs, context);
  }
};

export const ghIssueCommentTool = {
  name: "gh_issue_comment",
  description: "Comment on a GitHub issue using gh api",
  risk: "high",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      number: { type: "number" },
      body: { type: "string" }
    },
    required: ["repo", "number", "body"],
    additionalProperties: false
  },
  async execute(args, context) {
    const endpoint = `repos/${args.repo}/issues/${args.number}/comments`;
    const commandArgs = ["api", endpoint, "-f", `body=${args.body}`];
    return runGhJson(commandArgs, context);
  }
};

export const ghPrCreateTool = {
  name: "gh_pr_create",
  description: "Create a pull request using gh CLI",
  risk: "high",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      repo: { type: "string" }
    },
    required: ["title", "body"],
    additionalProperties: false
  },
  async execute(args, context) {
    const commandArgs = ["pr", "create", "--title", args.title, "--body", args.body];
    if (args.base) {
      commandArgs.push("--base", args.base);
    }
    if (args.head) {
      commandArgs.push("--head", args.head);
    }
    if (args.repo) {
      commandArgs.push("--repo", args.repo);
    }
    const result = await runSandboxedProcess("gh", commandArgs, {
      cwd: context.cwd,
      timeoutMs: 120000,
      outputLimit: 120000,
      networkBlocked: false,
      onStdout: (text) => context.onLog?.({ stage: "gh", channel: "stdout", text }),
      onStderr: (text) => context.onLog?.({ stage: "gh", channel: "stderr", text })
    });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "gh pr create failed");
    }
    return { url: result.stdout.trim() };
  }
};

export const ghPrReviewTool = {
  name: "gh_pr_review",
  description: "Review a pull request using gh CLI",
  risk: "high",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number" },
      body: { type: "string" },
      action: { type: "string", enum: ["approve", "request-changes", "comment"] },
      repo: { type: "string" }
    },
    required: ["number", "body", "action"],
    additionalProperties: false
  },
  async execute(args, context) {
    const commandArgs = ["pr", "review", String(args.number), "--body", args.body];
    if (args.action === "approve") {
      commandArgs.push("--approve");
    } else if (args.action === "request-changes") {
      commandArgs.push("--request-changes");
    } else {
      commandArgs.push("--comment");
    }
    if (args.repo) {
      commandArgs.push("--repo", args.repo);
    }
    const result = await runSandboxedProcess("gh", commandArgs, {
      cwd: context.cwd,
      timeoutMs: 120000,
      outputLimit: 120000,
      networkBlocked: false,
      onStdout: (text) => context.onLog?.({ stage: "gh", channel: "stdout", text }),
      onStderr: (text) => context.onLog?.({ stage: "gh", channel: "stderr", text })
    });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "gh pr review failed");
    }
    return { reviewed: true, action: args.action };
  }
};
