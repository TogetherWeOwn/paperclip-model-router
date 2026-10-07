#!/usr/bin/env node
/**
 * Per-run usage report on a within-session delta basis.
 *
 * `usageJson` on a resumed run holds the session's running total, so summing it
 * over runs overstates spend. This job reads a window of heartbeat runs, turns
 * each run's counters into its own usage (see scripts/lib/run-usage.mjs), and
 * prints the naive sum next to the delta sum plus breakdowns by wake reason,
 * session reuse and model. Use it, not a raw sum of `usageJson`, to compare a
 * context cap, a session policy or a model change.
 *
 * Usage:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
 *     node scripts/run-usage-report.mjs --hours 168 [--until ISO] [--agent <id>] [--markdown out.md]
 *
 * A window longer than the 1000-row-per-agent page is reported in
 * `truncatedAgents`; their oldest resumed runs lose their predecessor and are
 * counted in `unanchored`, never as cumulative totals.
 */

import { writeFileSync } from "node:fs";
import { collectRuns } from "./lib/heartbeat-runs.mjs";
import { perRunUsage, summarize, summarizeBy } from "./lib/run-usage.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => {
    if (!a.startsWith("--")) return [];
    const eq = a.indexOf("=");
    if (eq > 0) return [[a.slice(2, eq), a.slice(eq + 1)]];
    const next = all[i + 1];
    return [[a.slice(2), next && !next.startsWith("--") ? next : "true"]];
  }),
);

const API = (process.env.PAPERCLIP_API_URL || "").replace(/\/$/, "");
const KEY = process.env.PAPERCLIP_API_KEY || "";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID || "";
if (!API || !KEY || !COMPANY) {
  console.error("run-usage-report: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(2);
}

const HOURS = Number(args.hours ?? 24);
const untilMs = args.until === undefined ? Date.now() : Date.parse(args.until);
if (!Number.isFinite(HOURS) || HOURS <= 0 || !Number.isFinite(untilMs)) {
  console.error("run-usage-report: --hours must be positive and --until an ISO timestamp");
  process.exit(2);
}
const sinceMs = untilMs - HOURS * 3600 * 1000;

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

const collected = await collectRuns({ api, companyId: COMPANY, sinceMs, untilMs });
for (const a of collected.truncatedAgents) {
  console.warn(
    `run-usage-report: WARNING ${a.name ?? a.agentId} returned a full page of ${a.rows} runs reaching back only to ${a.oldestFetched}`,
  );
}

const rows = args.agent ? collected.rows.filter((r) => r.agentId === args.agent) : collected.rows;
const { runs, unanchored, counterResets } = perRunUsage(rows);
const succeeded = runs.filter((r) => r.status === "succeeded");

const naiveCostUsd = succeeded.reduce((acc, r) => acc + r.cumulative.costUsd, 0);
const delta = summarize(succeeded);
const report = {
  window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), hours: HOURS },
  agent: args.agent ?? null,
  distinctRuns: rows.length,
  withUsage: runs.length,
  unanchoredResumedRuns: unanchored,
  counterResets,
  truncatedAgents: collected.truncatedAgents,
  naiveCostUsd,
  deltaCostUsd: delta.costUsd,
  overstatement: delta.costUsd > 0 ? naiveCostUsd / delta.costUsd : null,
  delta,
  byResumed: summarizeBy(succeeded, (r) => (r.resumed ? "resumed" : "fresh")),
  byWake: summarizeBy(succeeded, (r) => `${r.wakeReason ?? "none"} / ${r.resumed ? "resumed" : "fresh"}`),
  byModel: summarizeBy(succeeded, (r) => r.model ?? "unknown"),
};

console.log(JSON.stringify(report, null, 2));

if (args.markdown) {
  const n = (v) => (v === null || v === undefined ? "-" : Math.round(v).toLocaleString("en-US"));
  const f = (v) => (v === null || v === undefined ? "-" : v.toFixed(2));
  const table = (title, groups) => [
    `### ${title}`,
    "",
    "| group | runs | median fresh in | median cache read | median out | re-read per output token | $ per run |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(groups)
      .sort((a, b) => b[1].runs - a[1].runs)
      .map(
        ([k, s]) =>
          `| ${k} | ${s.runs} | ${n(s.medianInputTokens)} | ${n(s.medianCachedInputTokens)} | ${n(s.medianOutputTokens)} | ${n(s.rereadPerOutputToken)} | ${f(s.costPerRun)} |`,
      ),
    "",
  ];
  const md = [
    `# Run usage, delta basis (${report.window.since} to ${report.window.until})`,
    "",
    `Succeeded runs with usage: ${report.delta.runs}. Unanchored resumed runs excluded: ${unanchored}.`,
    `Naive sum of \`usageJson.costUsd\`: $${n(naiveCostUsd)}. Delta sum: $${n(delta.costUsd)}. Overstatement: ${f(report.overstatement)}x.`,
    "",
    ...table("By session reuse", report.byResumed),
    ...table("By wake reason", report.byWake),
    ...table("By model", report.byModel),
  ].join("\n");
  writeFileSync(args.markdown, `${md}\n`);
}
