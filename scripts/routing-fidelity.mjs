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
 * Notes on the API surface used here:
 * - `GET .../heartbeat-runs?limit=&offset=` paginates (default order is
 *   newest-first). There is no server-side time filter — `since` is ignored —
 *   so the window is applied client-side on `createdAt`.
 * - Runs with no `usage_json.model` are counted separately, never as matches.
 *
 * Usage:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
 *     node scripts/routing-fidelity.mjs --hours 24 [--max-runs 2000] [--markdown out.md]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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
const MAX_RUNS = Number(args["max-runs"] ?? 2000);
const PAGE = 200;

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

const sinceMs = Date.now() - HOURS * 3600 * 1000;

// Newest-first pages; stop once a page's oldest row predates the window.
const rows = [];
for (let offset = 0; rows.length < MAX_RUNS; offset += PAGE) {
  const page = await api(`/api/companies/${COMPANY}/heartbeat-runs?limit=${PAGE}&offset=${offset}`);
  if (!Array.isArray(page) || page.length === 0) break;
  for (const r of page) {
    const created = Date.parse(r?.createdAt ?? "");
    if (Number.isFinite(created) && created < sinceMs) {
      offset = Number.MAX_SAFE_INTEGER; // stop outer loop after this page
      break;
    }
    rows.push(r);
    if (rows.length >= MAX_RUNS) break;
  }
  if (offset === Number.MAX_SAFE_INTEGER) break;
  if (page.length < PAGE) break;
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
  generatedAt: new Date().toISOString(),
  windowOldest,
  windowNewest,
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
    `| Runs in window | ${report.totalRuns} (${windowOldest} → ${windowNewest}, ${issueIds.length} issues) | — |`,
    `| Routed share | ${report.routedRuns}/${report.totalRuns} (${pct(report.routedShare)}) | ≥ 99% |`,
    `| No-model runs | ${report.noModelRuns} | counted separately |`,
    `| Fidelity (normalized) | ${report.fidelityMatches}/${report.fidelityDenominator} (${pct(report.fidelity)}) | ≥ 99% |`,
    `| Fidelity (raw exact match) | ${rawMatches}/${rawDenominator} (${pct(rawDenominator ? rawMatches / rawDenominator : 0)}) | — |`,
    `| … no-model among routed | ${report.fidelityNoModelRuns} | — |`,
    `| First-run coverage (issue_assigned) | ${report.firstRunDecided}/${report.firstRunTotal} (${pct(report.firstRunCoverage)}) | ≥ 99% |`,
    `| Escaped runs (configuration_incomplete) | ${report.escapedRuns} | 0/day |`,
    `| Pins with secret_ref env | ${report.staleSecretPins}/${report.pinsTotal} | 0 |`,
    ...(report.escapedIssueIds.length ? [``, `Escaped issues: ${report.escapedIssueIds.join(", ")}`] : []),
    ``,
  ].join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.markdown, md);
  console.error(`markdown: ${args.markdown}`);
}
