import {
  buildIntelligenceIndex,
  findReferences,
  findSymbol,
  getIndexHealth,
  listModules
} from "../../indexer/intelligence.mjs";

async function getIndex(context) {
  if (!context.runtimeCache) {
    context.runtimeCache = {};
  }
  if (!context.runtimeCache.intelligenceIndex || Date.now() - context.runtimeCache.intelligenceIndex.createdAt > 30000) {
    context.runtimeCache.intelligenceIndex = await buildIntelligenceIndex(context.cwd);
  }
  return context.runtimeCache.intelligenceIndex;
}

export const findSymbolTool = {
  name: "find_symbol",
  description: "Find symbols by name",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" }
    },
    required: ["name"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.name !== "string" || args.name.length === 0) {
      throw new Error("name is required");
    }
    const index = await getIndex(context);
    return { matches: findSymbol(index, args.name) };
  }
};

export const findReferencesTool = {
  name: "find_references",
  description: "Find references for a symbol",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" }
    },
    required: ["symbol"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.symbol !== "string" || args.symbol.length === 0) {
      throw new Error("symbol is required");
    }
    const index = await getIndex(context);
    return { references: findReferences(index, args.symbol) };
  }
};

export const listModulesTool = {
  name: "list_modules",
  description: "List modules and dependency edges",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(_args, context) {
    const index = await getIndex(context);
    return { modules: listModules(index) };
  }
};

export const indexHealthTool = {
  name: "index_health",
  description: "Show intelligence index status and freshness",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      forceRebuild: { type: "boolean" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    if (args.forceRebuild === true) {
      context.runtimeCache = context.runtimeCache || {};
      context.runtimeCache.intelligenceIndex = await buildIntelligenceIndex(context.cwd, {
        forceRebuild: true
      });
    }
    const index = await getIndex(context);
    return { health: getIndexHealth(index) };
  }
};
