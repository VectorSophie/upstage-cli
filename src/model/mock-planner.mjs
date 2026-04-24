function parseReadPath(input) {
  const lowered = input.toLowerCase();
  const marker = "read ";
  const idx = lowered.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  return input.slice(idx + marker.length).trim();
}

export function planNextAction(input, loopContext) {
  const text = input.trim();
  const lowered = text.toLowerCase();

  if (!text) {
    return {
      type: "stop",
      response: "Please provide a prompt.",
      stopReason: "needs_user_input"
    };
  }

  if (lowered === "/tools") {
    return {
      type: "respond",
      response: `Available tools: ${loopContext.registry.list().map((t) => t.name).join(", ")}`
    };
  }

  if (lowered.startsWith("echo ")) {
    return {
      type: "tool_call",
      toolName: "echo",
      args: { text: text.slice(5) }
    };
  }

  if (lowered.includes("list files") || lowered === "ls") {
    return {
      type: "tool_call",
      toolName: "list_files",
      args: { path: "." }
    };
  }

  const readPath = parseReadPath(text);
  if (readPath) {
    return {
      type: "tool_call",
      toolName: "read_file",
      args: { path: readPath }
    };
  }

  return {
    type: "respond",
    response:
      "Prototype loop active. Try: 'list files', 'read package.json', or 'echo hello'."
  };
}
