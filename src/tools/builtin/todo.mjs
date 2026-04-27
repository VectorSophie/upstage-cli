// Session-scoped task list — persists across tool calls within one session.
// Keyed by session ID so parallel sessions don't collide.
const TODOS = new Map(); // sessionId → Todo[]

function getKey(context) {
  return context?.session?.id || context?.sessionId || "__default__";
}

function getTodos(context) {
  const key = getKey(context);
  if (!TODOS.has(key)) TODOS.set(key, []);
  return TODOS.get(key);
}

function renderList(todos) {
  if (todos.length === 0) return "(no tasks)";
  return todos.map((t) => {
    const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : t.status === "skipped" ? "–" : "○";
    return `${icon} [${t.id}] ${t.task}`;
  }).join("\n");
}

export const todoWriteTool = {
  name: "todo_write",
  description: "Update the session task list. Use this to plan multi-step work and track progress. Call it whenever you start, complete, or skip a task.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Full replacement task list. Each item: { id, task, status }",
        items: {
          type: "object",
          properties: {
            id:     { type: "number" },
            task:   { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] }
          },
          required: ["id", "task", "status"],
          additionalProperties: false
        }
      }
    },
    required: ["todos"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (!Array.isArray(args.todos)) throw new Error("todos must be an array");
    const key = getKey(context);
    TODOS.set(key, args.todos);
    return {
      saved: args.todos.length,
      list: renderList(args.todos)
    };
  }
};

export const todoReadTool = {
  name: "todo_read",
  description: "Read the current session task list. Call this at the start of a multi-step task to see what is pending.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(_args, context) {
    const todos = getTodos(context);
    return {
      count: todos.length,
      list: renderList(todos),
      todos
    };
  }
};
