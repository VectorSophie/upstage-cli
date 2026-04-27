import { request } from "node:https";

const TAVILY_HOST = "api.tavily.com";
const MAX_RESULTS = 10;

function tavilySearch(query, maxResults, apiKey, searchDepth) {
  const body = JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: searchDepth });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: TAVILY_HOST,
        path: "/search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: 20000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) return reject(new Error(`Tavily API ${res.statusCode}: ${text.slice(0, 300)}`));
            resolve(JSON.parse(text));
          } catch (e) { reject(e); }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Tavily API request timed out")); });
    req.write(body);
    req.end();
  });
}

export const webSearchTool = {
  name: "web_search",
  description: "Search the web via Tavily. Requires TAVILY_API_KEY env var.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      query:       { type: "string" },
      count:       { type: "number",  description: "Number of results (default: 5, max: 10)" },
      deep:        { type: "boolean", description: "Use advanced search depth (slower, more thorough)" }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TAVILY_API_KEY environment variable is not set. " +
        "Get a free key at https://app.tavily.com"
      );
    }
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required");
    }

    const count       = Math.min(typeof args.count === "number" ? args.count : 5, MAX_RESULTS);
    const searchDepth = args.deep ? "advanced" : "basic";
    const data        = await tavilySearch(args.query.trim(), count, apiKey, searchDepth);

    const results = (data.results || []).map((r) => ({
      title:   r.title,
      url:     r.url,
      content: r.content || "",
      score:   r.score ?? null
    }));

    return {
      query:       args.query,
      searchDepth,
      answer:      data.answer || null,
      count:       results.length,
      results
    };
  }
};
