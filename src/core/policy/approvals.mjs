function isYes(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "y";
}

export function createInteractiveApprovalHandler({ rl, onEvent } = {}) {
  return async (payload) => {
    if (!rl || typeof rl.question !== "function") {
      return false;
    }

    const prompt = `Confirm ${payload.tool} (${payload.actionClass || payload.risk || "unknown"})? [y/N] `;
    const approved = await new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(isYes(answer)));
    });

    if (typeof onEvent === "function") {
      onEvent({
        type: "POLICY_DECISION",
        source: "interactive_approval",
        tool: payload.tool,
        actionClass: payload.actionClass || null,
        approved
      });
    }

    return approved;
  };
}

export function createNonInteractiveApprovalHandler({ mode = "deny", onEvent } = {}) {
  return async (payload) => {
    const approved = mode === "allow";
    if (typeof onEvent === "function") {
      onEvent({
        type: "POLICY_DECISION",
        source: "non_interactive_approval",
        tool: payload.tool,
        actionClass: payload.actionClass || null,
        approved,
        mode
      });
    }
    return approved;
  };
}
