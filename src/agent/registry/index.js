const DEFAULT_ROLES = {
  planner: {
    name: "planner",
    description: "Plans work and proposes execution order"
  },
  explorer: {
    name: "explorer",
    description: "Searches and inspects codebase context"
  },
  editor: {
    name: "editor",
    description: "Applies code changes and refactors"
  },
  reviewer: {
    name: "reviewer",
    description: "Validates changes and quality gates"
  }
};

export class AgentRoleRegistry {
  constructor(seed = DEFAULT_ROLES) {
    this.roles = new Map(Object.entries(seed));
  }

  get(roleName) {
    return this.roles.get(roleName);
  }

  list() {
    return Array.from(this.roles.values());
  }
}

export function createDefaultAgentRoleRegistry() {
  return new AgentRoleRegistry();
}
