export const echoTool = {
  name: "echo",
  description: "Echoes text back",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" }
    },
    required: ["text"],
    additionalProperties: false
  },
  async execute(args) {
    const text = typeof args.text === "string" ? args.text : "";
    return { text };
  }
};
