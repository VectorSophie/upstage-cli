function pct(v) {
  if (v === null || v === undefined) return " — ";
  return `${Math.round(v * 100)}%`;
}

function usd(v) {
  if (v === null || v === undefined) return " — ";
  return `$${Number(v).toFixed(3)}`;
}

function dur(ms) {
  if (ms === null || ms === undefined) return " — ";
  return `${Math.round(ms / 1000)}s`;
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function rpad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function comparisonTable(runs) {
  if (!runs || runs.length === 0) return "No runs to compare.";

  const cols = {
    Agent:      { fn: (r) => r.agentId || "?",                        w: 20 },
    Status:     { fn: (r) => r.status === "pass" ? "PASS ✓" : "FAIL ✗", w: 8 },
    Score:      { fn: (r) => Math.round((r.evaluation?.score || 0) * 100), w: 6 },
    "FTP%":     { fn: (r) => pct(r.evaluation?.failToPassRate),        w: 6 },
    "PTP%":     { fn: (r) => pct(r.evaluation?.passToPassRate),        w: 6 },
    Cost:       { fn: (r) => usd(r.metrics?.estimatedCostUsd),         w: 8 },
    Time:       { fn: (r) => dur(r.durationMs),                        w: 7 },
    Patch:      { fn: (r) => `+${r.metrics?.patch?.linesAdded ?? 0}/-${r.metrics?.patch?.linesRemoved ?? 0}`, w: 9 },
    Tools:      { fn: (r) => r.metrics?.toolCalls ?? 0,                w: 6 },
    Failure:    { fn: (r) => r.failure?.symptom || "none",             w: 24 }
  };

  const keys = Object.keys(cols);
  const header = "| " + keys.map((k) => pad(k, cols[k].w)).join(" | ") + " |";
  const sep    = "|-" + keys.map((k) => "-".repeat(cols[k].w)).join("-|-") + "-|";

  const rows = runs.map((r) => {
    const cells = keys.map((k) => pad(String(cols[k].fn(r)), cols[k].w));
    return "| " + cells.join(" | ") + " |";
  });

  return [header, sep, ...rows].join("\n");
}

export function deltaColumn(baseline, runs, metric) {
  return runs.map((r) => {
    const bv = metric(baseline);
    const rv = metric(r);
    if (bv === null || rv === null) return null;
    return rv - bv;
  });
}
