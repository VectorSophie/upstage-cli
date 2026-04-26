export class SkillRunner {
  constructor(loader, agentLoop) {
    this.loader = loader;
    this.agentLoop = agentLoop;
  }

  async *execute(name, args = "") {
    const prompt = this.loader.run(name, args);
    const message = `[Invoking skill: ${name}]\n\n${prompt}`;
    yield* this.agentLoop(message);
  }

  listAvailable() {
    return this.loader.list();
  }
}
