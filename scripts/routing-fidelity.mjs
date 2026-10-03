#!/usr/bin/env node
/**
 * Routing-fidelity job (TOG-11796, design TOG-11780 §8).
 *
 * Fetches a window of heartbeat runs, joins each issue-bound run to its
 * issue's CURRENT pin, normalizes both model names through
 * `src/fidelity/*`, and prints a JSON report plus a markdown baseline.
 *
 * Interim pin-vs-run proxy: the `modelDecision` record (§4.2) does not exist
 * yet (0 rows carry it), so "routed" means "the issue carries a pin".
 * See FIDELITY_CAVEAT. Re-point the decision fetch at
 * `contextSnapshot.modelDecision` once TOG-11792 ships.
 *
 * Notes on the API surface used here (details in scripts/lib/heartbeat-runs.mjs):
 * - `GET .../heartbeat-runs` returns the newest `limit` rows (hard cap 1000)
 *   and ignores `offset` and every cursor or time param, so it cannot be paged
 *   backwards. `agentId=` is honored: the job reads one page per agent, dedupes
 *   by run id and applies the window client-side on `createdAt`. An agent whose
 *   whole page sits inside the window is listed in `truncatedAgents`.
 * - Runs with no `usage_json.model` are counted separately, never as matches.
 *
 * Usage:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
 *     node scripts/routing-fidelity.mjs --hours 24 [--until ISO] [--max-runs N] [--markdown out.md]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { collectRuns } from "./lib/heartbeat-runs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadFidelity() {
  const out = join(mkdtempSync(join(tmpdir(), "routing-fidelity-")), "fidelity.mjs");
  execFileSync(
    join(root, "node_modules/.bin/esbuild"),
    [
      join(root, "src/fidelity/metrics.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${out}`,
      "--log-level=error",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return import(pathToFileURL(out).href);
}

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
  console.error("routing-fidelity: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(2);
}

const HOURS = Number(args.hours ?? 24);
// Optional cap on kept runs (newest first). Unset means the whole window.
const MAX_RUNS = args["max-runs"] === undefined ? Infinity : Number(args["max-runs"]);

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

function isSecretRef(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.type === "secret_ref" || value.type === "user_secret_ref")
  );
}

// Window end defaults to now; --until <ISO> re-runs an earlier window. The pin
// side of the proxy is still the CURRENT pin, and the 1000-row-per-agent cap
// makes older windows more likely to be reported as truncated.
const untilMs = args.until === undefined ? Date.now() : Date.parse(args.until);
if (!Number.isFinite(untilMs)) {
  console.error(`routing-fidelity: --until must be an ISO timestamp, got ${args.until}`);
  process.exit(2);
}
const sinceMs = untilMs - HOURS * 3600 * 1000;

const {
  rows,
  distinctRuns,
  agentsScanned,
  duplicateRowsDropped,
  undatedRows,
  truncatedAgents,
  cappedAtMaxRuns,
} = await collectRuns({ api, companyId: COMPANY, sinceMs, untilMs, maxRuns: MAX_RUNS });

for (const a of truncatedAgents) {
  console.warn(
    `routing-fidelity: WARNING ${a.name ?? a.agentId} returned a full page of ${a.rows} runs reaching back only to ${a.oldestFetched}; ` +
      `its older in-window runs are not counted`,
  );
}
if (cappedAtMaxRuns) {
  console.warn(`routing-fidelity: WARNING --max-runs ${MAX_RUNS} dropped the oldest in-window runs`);
}

const issueIds = [...new Set(rows.map((r) => r?.contextSnapshot?.issueId).filter(Boolean))];
const pins = new Map();
const CONCURRENCY = 8;
for (let i = 0; i < issueIds.length; i += CONCURRENCY) {
  const chunk = await Promise.all(
    issueIds.slice(i, i + CONCURRENCY).map(async (id) => {
      try {
        return [id, await api(`/api/issues/${id}`)];
      } catch {
        return [id, null];
      }
    }),
  );
  for (const [id, issue] of chunk) {
    const adapterConfig = issue?.assigneeAdapterOverrides?.adapterConfig ?? {};
    const env = adapterConfig.env ?? {};
    pins.set(id, {
      model: typeof adapterConfig.model === "string" ? adapterConfig.model : null,
      hasSecretRefEnv:
        env !== null && typeof env === "object" && Object.values(env).some(isSecretRef),
    });
  }
}

const { computeFidelity } = await loadFidelity();
const included = rows.filter((r) => r?.contextSnapshot?.issueId);
const created = included.map((r) => Date.parse(r?.createdAt ?? "")).filter(Number.isFinite);
const windowOldest = created.length ? new Date(Math.min(...created)).toISOString() : null;
const windowNewest = created.length ? new Date(Math.max(...created)).toISOString() : null;
// Raw exact-match fidelity alongside the normalized figure, so the report
// shows what the alias table contributes instead of hiding it.
let rawMatches = 0;
let rawDenominator = 0;
for (const r of included) {
  const reported = typeof r?.usageJson?.model === "string" ? r.usageJson.model : null;
  const decided = pins.get(r.contextSnapshot.issueId)?.model ?? null;
  if (reported != null && reported !== "" && decided != null && decided !== "") {
    rawDenominator += 1;
    if (reported === decided) rawMatches += 1;
  }
}
const report = computeFidelity(
  rows
    .filter((r) => r?.contextSnapshot?.issueId)
    .map((r) => ({
      issueId: r.contextSnapshot.issueId,
      wakeReason: r.contextSnapshot.wakeReason ?? null,
      reportedModel: typeof r?.usageJson?.model === "string" ? r.usageJson.model : null,
      errorCode: r.errorCode ?? null,
    })),
  pins,
);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const output = {
  windowHours: HOURS,
  windowUntil: new Date(untilMs).toISOString(),
  generatedAt: new Date().toISOString(),
  windowOldest,
  windowNewest,
  distinctRuns,
  agentsScanned,
  duplicateRowsDropped,
  undatedRows,
  truncatedAgents,
  cappedAtMaxRuns,
  distinctIssues: issueIds.length,
  rawExactMatches: rawMatches,
  rawExactDenominator: rawDenominator,
  ...report,
};
console.log(JSON.stringify(output, null, 2));

if (args.markdown) {
  const md = [
    `# Routing fidelity — last ${HOURS} h`,
    ``,
    `Generated ${output.generatedAt}. ${report.caveat}`,
    ``,
    `| Metric | Value | Target |`,
    `|---|---|---|`,
    `| Runs in window | ${distinctRuns} distinct, ${report.totalRuns} issue-bound (${windowOldest} → ${windowNewest}, ${issueIds.length} issues, ${agentsScanned} agents) | — |`,
    `| Routed share | ${report.routedRuns}/${report.totalRuns} (${pct(report.routedShare)}) | ≥ 99% |`,
    `| No-model runs | ${report.noModelRuns} | counted separately |`,
    `| Fidelity (normalized) | ${report.fidelityMatches}/${report.fidelityDenominator} (${pct(report.fidelity)}) | ≥ 99% |`,
    `| Fidelity (raw exact match) | ${rawMatches}/${rawDenominator} (${pct(rawDenominator ? rawMatches / rawDenominator : 0)}) | — |`,
    `| … no-model among routed | ${report.fidelityNoModelRuns} | — |`,
    `| First-run coverage (issue_assigned) | ${report.firstRunDecided}/${report.firstRunTotal} (${pct(report.firstRunCoverage)}) | ≥ 99% |`,
    `| Escaped runs (configuration_incomplete) | ${report.escapedRuns} | 0/day |`,
    `| Pins with secret_ref env | ${report.staleSecretPins}/${report.pinsTotal} | 0 |`,
    ...(report.escapedIssueIds.length ? [``, `Escaped issues: ${report.escapedIssueIds.join(", ")}`] : []),
    ...(truncatedAgents.length
      ? [
          ``,
          `Truncated (the API returns at most 1000 runs per agent and these pages stop short of the window start; their older runs are not counted):`,
          ...truncatedAgents.map((a) => `- ${a.name ?? a.agentId}: ${a.rows} runs, oldest fetched ${a.oldestFetched}`),
        ]
      : []),
    ``,
  ].join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.markdown, md);
  console.error(`markdown: ${args.markdown}`);
}
