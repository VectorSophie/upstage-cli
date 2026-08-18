// Resource tier of the skills catalog (docs/skills-research-aug2026.md §2):
// the catalog (name + description, from SkillsLoader.list()) is already
// folded into the system prompt cheaply by system-prompt.mjs; this loads
// one skill's full prompt only once the model has decided a task actually
// matches it. Reuses the same SkillsLoader instance already loaded once at
// startup (runtimeCache.skillsLoader) rather than re-scanning the
// filesystem — same instance the /skills command and the manual
// `/skill-name` slash-invocation fallback in commands.mjs both read from.
export const loadSkillTool = {
  name: "load_skill",
  description:
    "Load the full instructions for a skill by exact name, once its catalog description (shown in the system " +
    "prompt) matches the current task. Skills are self-contained how-to guides (Korean payment/OAuth/cloud " +
    "integration patterns, PII/groundedness usage guidance, etc.), not a substitute for the tools they reference.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, exactly as shown in the catalog" }
    },
    required: ["name"],
    additionalProperties: false
  },
  async execute(args, context) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) throw new Error("name is required");

    const loader = context.runtimeCache?.skillsLoader;
    const skill = loader?.get?.(name);
    if (!skill) {
      const available = loader?.list?.().map((s) => s.name).join(", ") || "(none)";
      throw new Error(`Unknown skill: ${name}. Available: ${available}`);
    }

    return { name: skill.name, instructions: skill.prompt, license: skill.license || null };
  }
};
