const DEFAULT_COMMANDS = [
  { name: "/help", description: "Show help and usage" },
  { name: "/tools", description: "List available tools" },
  { name: "/tree", description: "Show repository map summary" },
  { name: "/reset", description: "Reset current session" },
  { name: "/sessions", description: "Show recent sessions" },
  { name: "/tasks", description: "Show task and activity summary" },
  { name: "/palette", description: "Search command palette" },
  { name: "/exit", description: "Exit interactive mode" }
];

function scoreCommand(command, query) {
  if (!query) {
    return 1;
  }

  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();
  const q = query.toLowerCase();

  if (name === q) {
    return 100;
  }
  if (name.startsWith(q)) {
    return 80;
  }
  if (name.includes(q)) {
    return 60;
  }
  if (description.includes(q)) {
    return 40;
  }

  return 0;
}

export function getDefaultCommands() {
  return DEFAULT_COMMANDS.slice();
}

export function rankCommands(query, commands = DEFAULT_COMMANDS) {
  const normalized = typeof query === "string" ? query.trim() : "";
  return commands
    .map((command) => ({
      ...command,
      score: scoreCommand(command, normalized)
    }))
    .filter((command) => command.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.name.localeCompare(right.name);
    });
}
