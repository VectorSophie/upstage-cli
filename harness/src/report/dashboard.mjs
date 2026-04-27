/**
 * Multi-run HTML dashboard with inline trend charts (Phase D).
 * Uses vanilla JS + SVG — no external dependencies.
 */
export function toHTML(runs) {
  if (!runs || runs.length === 0) return "<html><body><p>No runs.</p></body></html>";

  const rows = runs.map((r) => {
    const score = Math.round((r.evaluation?.score || 0) * 100);
    const ftp = Math.round((r.evaluation?.failToPassRate || 0) * 100);
    const ptp = Math.round((r.evaluation?.passToPassRate || 0) * 100);
    const cost = (r.metrics?.estimatedCostUsd || 0).toFixed(4);
    const dur = Math.round((r.durationMs || 0) / 1000);
    const status = r.status === "pass" ? "✓" : "✗";
    const statusClass = r.status === "pass" ? "pass" : "fail";
    return `<tr class="${statusClass}">
      <td>${r.id || "—"}</td>
      <td>${r.agentId || "—"}</td>
      <td>${r.taskId || "—"}</td>
      <td class="center">${status}</td>
      <td class="right">${score}</td>
      <td class="right">${ftp}%</td>
      <td class="right">${ptp}%</td>
      <td class="right">$${cost}</td>
      <td class="right">${dur}s</td>
      <td>${r.failure?.symptom || "—"}</td>
    </tr>`;
  }).join("\n");

  const scorePoints = sparkline(runs.map((r) => (r.evaluation?.score || 0) * 100));
  const ftpPoints = sparkline(runs.map((r) => (r.evaluation?.failToPassRate || 0) * 100));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Harness Dashboard</title>
<style>
  body { font-family: monospace; font-size: 13px; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { color: #E899F2; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th { background: #161b22; color: #8b949e; padding: 6px 10px; text-align: left; border-bottom: 1px solid #30363d; }
  td { padding: 5px 10px; border-bottom: 1px solid #21262d; }
  .pass td:nth-child(4) { color: #3fb950; }
  .fail td:nth-child(4) { color: #f85149; }
  .center { text-align: center; }
  .right { text-align: right; }
  .chart { margin-top: 24px; }
  svg { display: block; }
  .label { color: #8b949e; font-size: 11px; margin-bottom: 4px; }
</style>
</head>
<body>
<h1>✦✧ Harness Dashboard</h1>
<p>${runs.length} run(s) · ${runs.filter((r) => r.status === "pass").length} passed</p>

<div class="chart">
  <div class="label">Score trend</div>
  ${scorePoints}
</div>
<div class="chart">
  <div class="label">Fail-to-pass rate trend</div>
  ${ftpPoints}
</div>

<table>
<tr>
  <th>Run ID</th><th>Agent</th><th>Task</th><th>Status</th>
  <th>Score</th><th>FTP%</th><th>PTP%</th><th>Cost</th><th>Time</th><th>Failure</th>
</tr>
${rows}
</table>
</body>
</html>`;
}

function sparkline(values, width = 400, height = 40) {
  if (values.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = Math.round((i / (values.length - 1)) * (width - 2)) + 1;
    const y = Math.round(((1 - (v - min) / range)) * (height - 4)) + 2;
    return `${x},${y}`;
  }).join(" ");
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <polyline points="${pts}" fill="none" stroke="#3D6AF2" stroke-width="2"/>
</svg>`;
}
