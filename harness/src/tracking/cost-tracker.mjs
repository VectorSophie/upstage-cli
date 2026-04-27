// Token pricing per million tokens (USD). Updated 2026-04.
const PRICING = {
  "solar-pro2":     { prompt: 1.50, completion: 4.50 },
  "gpt-4o":         { prompt: 2.50, completion: 10.00 },
  "gpt-4o-mini":    { prompt: 0.15, completion: 0.60 },
  "gemini-1.5-pro": { prompt: 1.25, completion: 5.00 },
  "gemini-2.0-flash": { prompt: 0.10, completion: 0.40 },
  "default":        { prompt: 2.00, completion: 6.00 }
};

export class CostTracker {
  constructor(budgetUsd = 1.0, model = "solar-pro2") {
    this.budgetUsd = budgetUsd;
    this.model = model;
    this._tasks = [];
  }

  _pricing() {
    const key = Object.keys(PRICING).find((k) => this.model.includes(k));
    return PRICING[key] || PRICING.default;
  }

  estimate(usage) {
    if (!usage) return 0;
    const p = this._pricing();
    const promptCost = ((usage.promptTokens || 0) / 1_000_000) * p.prompt;
    const completionCost = ((usage.completionTokens || 0) / 1_000_000) * p.completion;
    return Math.round((promptCost + completionCost) * 1_000_000) / 1_000_000;
  }

  record(taskId, usage, passed) {
    const costUsd = this.estimate(usage);
    this._tasks.push({ taskId, costUsd, passed, usage });
    return costUsd;
  }

  costPerTask() {
    if (this._tasks.length === 0) return 0;
    const total = this._tasks.reduce((s, t) => s + t.costUsd, 0);
    return total / this._tasks.length;
  }

  costPerSuccessfulFix() {
    const passed = this._tasks.filter((t) => t.passed);
    if (passed.length === 0) return null;
    const total = passed.reduce((s, t) => s + t.costUsd, 0);
    return total / passed.length;
  }

  paretoFrontier() {
    return this._tasks
      .slice()
      .sort((a, b) => a.costUsd - b.costUsd)
      .map((t, i) => ({
        rank: i + 1,
        taskId: t.taskId,
        costUsd: t.costUsd,
        passed: t.passed
      }));
  }

  summary() {
    return {
      tasks: this._tasks.length,
      totalCostUsd: this._tasks.reduce((s, t) => s + t.costUsd, 0),
      costPerTask: this.costPerTask(),
      costPerSuccessfulFix: this.costPerSuccessfulFix(),
      budgetUsd: this.budgetUsd
    };
  }
}
