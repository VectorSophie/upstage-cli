import { request } from "node:https";

const BRAVE_API_URL = "api.search.brave.com";
const BRAVE_API_PATH = "/res/v1/web/search";
const MAX_RESULTS = 10;

function braveSearch(query, count, apiKey) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ q: query, count: String(count), text_decorations: "false" });
    const options = {
      hostname: BRAVE_API_URL,
      path: `${BRAVE_API_PATH}?${qs}`,
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey
      },
      timeout: 15000
    };
    const req = request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) return reject(new Error(`Brave API ${res.statusCode}: ${body.slice(0, 200)}`));
          resolve(JSON.parse(body));
        } catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Brave API request timed out")); });
    req.end();
  });
}

export const webSearchTool = {
  name: "web_search",
  description: "Search the web via Brave Search API. Requires BRAVE_API_KEY env var.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      query:   { type: "string" },
      count:   { type: "number", description: "Number of results (default: 5, max: 10)" }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args) {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "BRAVE_API_KEY environment variable is not set. " +
        "Get a free key at https://api.search.brave.com/app/keys"
      );
    }
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required");
    }

    const count = Math.min(typeof args.count === "number" ? args.count : 5, MAX_RESULTS);
    const data = await braveSearch(args.query.trim(), count, apiKey);

    const results = (data.web?.results || []).map((r) => ({
      title:       r.title,
      url:         r.url,
      description: r.description || ""
    }));

    return {
      query: args.query,
      count: results.length,
      results
    };
  }
};
