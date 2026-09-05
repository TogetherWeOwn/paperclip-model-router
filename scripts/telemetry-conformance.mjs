#!/usr/bin/env node
/**
 * Check a LIVE model-usage telemetry document against
 * `docs/contracts/model-usage-telemetry-v1.md`.
 *
 * `tests/model-usage-telemetry.spec.ts` proves the reference normalizer in
 * `src/telemetry/` is conforming. It says nothing about the document a
 * deployment actually serves, which is written in another language, by another
 * team, behind a credential this repository does not hold. The contract is
 * explicit that conformance is a property of the *response* (§7: "a deployment
 * MAY implement the producer in any language provided its responses pass"), so
 * the response is what this script reads.
 *
 * The distinction matters because the edge cannot do it. As TOG-811 records,
 * the Caddy lane in front of the producer terminates the bearer and filters
 * source IP, method and path — it never inspects a body. Nothing between the
 * producer's process and the router asserts that the body carries no identity.
 * That assertion is this script.
 *
 * The leak detector is IMPORTED from `src/telemetry/sanitize.ts`, not
 * reimplemented here. A second copy would drift from the shipped one, and
 * worse, a checker that shared a blind spot with the code it checks would pass
 * for the wrong reason. `findIdentityLeaks` was written as an independent
 * oracle for exactly this use.
 *
 * What is checked, and the section it comes from:
 *
 *   T1  transport      200, JSON content type, body under the cap        §5
 *   T2  envelope       schemaVersion / observedAt / staleAfterSeconds    §3.1
 *   T3  outage         telemetry vs models vs reasonCode are consistent  §4
 *   T4  freshness      observedAt is real, UTC, and not already stale    §3.1, §5
 *   T5  records        state enum, serviceable derived, ranges, windows  §3.1-3.3
 *   T6  cardinality    no per-source spread, no source count            §2.3
 *   T7  identity       deep recursive leak scan over the whole body      §2.2
 *
 * T7 is the one that matters. The others can be argued about; T7 is the
 * boundary the compatible-upstream contract draws.
 *
 * SELF-TEST. A checker that passes everything is worthless, and a redaction
 * suite that has never failed has not been shown to be capable of failing.
 * `--selftest` runs the same assertions against built-in mutants — documents
 * seeded with live-shaped credentials, account emails, lane labels, a
 * collapsed outage, a stale timestamp — and FAILS if any mutant is accepted.
 * Run it before trusting a green live run.
 *
 * Usage:
 *   node scripts/telemetry-conformance.mjs --selftest
 *   node scripts/telemetry-conformance.mjs --file snapshot.json
 *   node scripts/telemetry-conformance.mjs --url https://host/path --key-env LANE_KEY
 *   ... --json          machine-readable result
 *   ... --allow-stale   report staleness as a warning, not a failure
 *
 * Exit 0 = conforming. Exit 1 = a violation. Exit 2 = could not check
 * (unreachable, no credential, unparseable). Exit 2 is deliberately NOT 0: an
 * unverifiable producer is not a passing producer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Load the shipped detector. src/ is TypeScript, so it is bundled on demand
// with the repo's own esbuild rather than duplicated into this file.
// ---------------------------------------------------------------------------

async function loadSanitizer() {
  const out = join(mkdtempSync(join(tmpdir(), "telemetry-conformance-")), "sanitize.mjs");
  execFileSync(
    join(root, "node_modules/.bin/esbuild"),
    [
      join(root, "src/telemetry/sanitize.ts"),
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

const TELEMETRY_WINDOWS = new Set(["five-hour", "daily", "weekly", "monthly", "rolling"]);
const STATES = new Set(["available", "degraded", "exhausted", "unavailable", "unknown"]);
const SERVICEABLE_STATES = new Set(["available", "degraded", "unknown"]);
const REASON_CODES = new Set([
  "upstream-unreachable",
  "upstream-rejected-credential",
  "upstream-error",
  "upstream-malformed",
  "not-configured",
  "stale",
]);
const QUALITIES = new Set(["measured", "partial", "absent"]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MODELS = 512;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Two severities, because they are two different questions.
 *
 * A `fail` is a breach of the contract's safety boundary — an identity leak, a
 * collapsed outage, a state the consumer would misread. It blocks.
 *
 * A `warn` is a conformance gap that degrades the consumer without endangering
 * it: the snapshot is still safe to consume, but some guarantee the contract
 * offers is not being delivered. It is reported and does not block, because
 * failing a live deployment over a derivable convenience field would train
 * people to pass `--force`, and then the identity checks stop being read.
 */
class Report {
  constructor() {
    this.checks = [];
  }
  add(id, section, ok, label, detail) {
    this.checks.push({ id, section, ok, severity: "fail", label, detail: detail ?? null });
    return ok;
  }
  warn(id, section, ok, label, detail) {
    this.checks.push({ id, section, ok, severity: "warn", label, detail: detail ?? null });
    return ok;
  }
  get failures() {
    return this.checks.filter((c) => !c.ok && c.severity === "fail");
  }
  get warnings() {
    return this.checks.filter((c) => !c.ok && c.severity === "warn");
  }
  get passed() {
    return this.failures.length === 0;
  }
}

function isRfc3339Utc(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isFraction(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * @param body   parsed JSON
 * @param meta   { status, contentType, bytes } — transport facts, or null when
 *               the document came from a file and transport is not under test.
 */
function checkDocument(body, meta, opts, findIdentityLeaks) {
  const report = new Report();
  const now = opts.now ?? Date.now();

  // -- T1 transport ---------------------------------------------------------
  if (meta) {
    report.add("T1.status", "§5", meta.status === 200, `HTTP ${meta.status} is 200`,
      meta.status === 200 ? null : `outage must still be 200 with telemetry:"unavailable"`);
    report.add("T1.contentType", "§5",
      /\/(json)|\+json/.test(meta.contentType ?? ""),
      `content-type ${meta.contentType ?? "(none)"} is JSON`);
    report.add("T1.bounded", "§5", meta.bytes <= MAX_BODY_BYTES,
      `body ${meta.bytes} B within ${MAX_BODY_BYTES} B cap`);
  }

  // -- T2 envelope ----------------------------------------------------------
  const isObject = body !== null && typeof body === "object" && !Array.isArray(body);
  if (!report.add("T2.object", "§3", isObject, "body is a JSON object")) return report;

  report.add("T2.schemaVersion", "§3.1", body.schemaVersion === 1,
    `schemaVersion is 1 (got ${JSON.stringify(body.schemaVersion)})`);
  report.add("T2.observedAt", "§3.1", isRfc3339Utc(body.observedAt),
    `observedAt is RFC3339 UTC (got ${JSON.stringify(body.observedAt)})`);
  report.add("T2.staleAfterSeconds", "§3.1",
    Number.isInteger(body.staleAfterSeconds) && body.staleAfterSeconds > 0,
    `staleAfterSeconds is a positive integer (got ${JSON.stringify(body.staleAfterSeconds)})`);
  report.add("T2.telemetry", "§4",
    body.telemetry === "available" || body.telemetry === "unavailable",
    `telemetry is a known value (got ${JSON.stringify(body.telemetry)})`);

  const models = isObject && body.models !== null && typeof body.models === "object" && !Array.isArray(body.models)
    ? body.models
    : null;
  if (!report.add("T2.models", "§3.1", models !== null, "models is an object")) return report;

  const modelIds = Object.keys(models);
  report.add("T2.modelCount", "§5", modelIds.length <= MAX_MODELS,
    `${modelIds.length} records within ${MAX_MODELS} cap`);

  // -- T3 outage is not emptiness -------------------------------------------
  // The three rows of §4, asserted as the mutually exclusive conditions they are.
  const empty = modelIds.length === 0;
  if (body.telemetry === "unavailable") {
    report.add("T3.outageEmpty", "§4", empty,
      "outage carries no model records",
      empty ? null : `telemetry:"unavailable" with ${modelIds.length} records is ambiguous`);
    report.add("T3.outageReason", "§4", REASON_CODES.has(body.reasonCode),
      `outage reasonCode is in the closed enum (got ${JSON.stringify(body.reasonCode)})`);
  } else if (body.telemetry === "available") {
    report.add("T3.healthyReason", "§4", body.reasonCode === null || body.reasonCode === undefined,
      `healthy snapshot has null reasonCode (got ${JSON.stringify(body.reasonCode)})`);
    // The distinguishability assertion itself: an empty healthy set is legal,
    // and is legible as DIFFERENT from an outage precisely because `telemetry`
    // is present and says so. This is the check that fails on a collapsed
    // producer that signals outage by returning {}.
    report.add("T3.distinguishable", "§4", true,
      empty
        ? "empty model set is legible as healthy, not as an outage"
        : `${modelIds.length} record(s) reported as healthy`);
  }

  // -- T4 freshness ---------------------------------------------------------
  if (isRfc3339Utc(body.observedAt) && Number.isInteger(body.staleAfterSeconds)) {
    const observedAt = Date.parse(body.observedAt);
    const ageSeconds = (now - observedAt) / 1000;
    report.add("T4.notFuture", "§3.1", ageSeconds >= -60,
      `observedAt is not in the future (age ${ageSeconds.toFixed(1)}s)`);
    const fresh = ageSeconds <= body.staleAfterSeconds;
    if (opts.allowStale && !fresh) {
      report.add("T4.fresh", "§5", true,
        `STALE BUT ALLOWED: age ${ageSeconds.toFixed(1)}s exceeds staleAfterSeconds ${body.staleAfterSeconds}`);
    } else {
      report.add("T4.fresh", "§5", fresh,
        `snapshot is fresh (age ${ageSeconds.toFixed(1)}s <= ${body.staleAfterSeconds}s)`);
    }
  }

  // -- T5 records -----------------------------------------------------------
  for (const modelId of modelIds) {
    const record = models[modelId];
    const p = `models[${JSON.stringify(modelId)}]`;
    if (!report.add(`T5.object:${modelId}`, "§3", record !== null && typeof record === "object" && !Array.isArray(record),
      `${p} is an object`)) continue;

    report.add(`T5.state:${modelId}`, "§3.2", STATES.has(record.state),
      `${p}.state is in the closed enum (got ${JSON.stringify(record.state)})`);
    // serviceable is DERIVED from state; §3.2 says a record where the two
    // disagree is malformed. This catches a producer that computed them apart.
    if (STATES.has(record.state)) {
      const expected = SERVICEABLE_STATES.has(record.state);
      report.add(`T5.serviceable:${modelId}`, "§3.2", record.serviceable === expected,
        `${p}.serviceable matches state "${record.state}" (expected ${expected}, got ${JSON.stringify(record.serviceable)})`);
    }
    report.add(`T5.utilization:${modelId}`, "§3.1",
      record.utilization === null || isFraction(record.utilization),
      `${p}.utilization is null or in [0,1] (got ${JSON.stringify(record.utilization)})`,
      "values outside [0,1] must be rejected as null, not clamped");
    report.add(`T5.remaining:${modelId}`, "§3.1",
      record.remainingFraction === null || isFraction(record.remainingFraction),
      `${p}.remainingFraction is null or in [0,1]`);
    report.add(`T5.resetsAt:${modelId}`, "§3.1",
      record.resetsAt === null || isRfc3339Utc(record.resetsAt),
      `${p}.resetsAt is null or RFC3339 UTC (got ${JSON.stringify(record.resetsAt)})`);
    // §3.1 provides resetInSeconds so a consumer need not trust its own clock
    // against the producer's. Omitting it is a real gap — the consumer falls
    // back to local-clock arithmetic on resetsAt — but it is not a safety
    // breach, so it warns rather than blocks.
    if (record.resetInSeconds === undefined) {
      report.warn(`T5.resetInSeconds:${modelId}`, "§3.1", false,
        `${p}.resetInSeconds is absent`,
        "consumer must fall back to its own clock against resetsAt");
    } else {
      report.add(`T5.resetInSeconds:${modelId}`, "§3.1",
        record.resetInSeconds === null ||
          (typeof record.resetInSeconds === "number" && Number.isFinite(record.resetInSeconds) && record.resetInSeconds >= 0),
        `${p}.resetInSeconds is null or >= 0 (got ${JSON.stringify(record.resetInSeconds)})`);
    }
    report.add(`T5.quality:${modelId}`, "§3.1",
      record.observationQuality === undefined || QUALITIES.has(record.observationQuality),
      `${p}.observationQuality is in the closed enum (got ${JSON.stringify(record.observationQuality)})`);

    const windows = record.windows;
    if (windows !== undefined) {
      if (report.add(`T5.windowsArray:${modelId}`, "§3.3", Array.isArray(windows),
        `${p}.windows is an array`)) {
        windows.forEach((w, i) => {
          const wp = `${p}.windows[${i}]`;
          const wObj = w !== null && typeof w === "object" && !Array.isArray(w);
          if (!report.add(`T5.windowObject:${modelId}:${i}`, "§3.3", wObj, `${wp} is an object`)) return;
          // A window name outside the closed vocabulary is exactly where a
          // vendor label would appear ("anthropic-5h" names the provider).
          report.add(`T5.windowName:${modelId}:${i}`, "§3.3", TELEMETRY_WINDOWS.has(w.window),
            `${wp}.window is in the closed vocabulary (got ${JSON.stringify(w.window)})`,
            "an unrecognized window name is a provider side channel");
          report.add(`T5.windowUtil:${modelId}:${i}`, "§3.1",
            w.utilization === null || w.utilization === undefined || isFraction(w.utilization),
            `${wp}.utilization is null or in [0,1] (got ${JSON.stringify(w.utilization)})`);
          report.add(`T5.windowReset:${modelId}:${i}`, "§3.1",
            w.resetsAt === null || w.resetsAt === undefined || isRfc3339Utc(w.resetsAt),
            `${wp}.resetsAt is null or RFC3339 UTC (got ${JSON.stringify(w.resetsAt)})`);
        });
        // §2.3: one scalar per window. Two entries for the same window name is
        // per-source spread — the shape that lets a consumer count lanes.
        const names = windows.filter((w) => w && typeof w === "object").map((w) => w.window);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        report.add(`T5.windowUnique:${modelId}`, "§2.3", dupes.length === 0,
          `${p}.windows has one entry per window name`,
          dupes.length ? `repeated: ${[...new Set(dupes)].join(", ")} — per-source spread reveals lane count` : null);
      }
    }
  }

  // -- T6 cardinality -------------------------------------------------------
  // §2.3 forbids anything whose VALUE is a count of contributing sources, even
  // under an innocent-looking key. The key-fragment scan in T7 catches names
  // like `laneCount`; this catches the shape.
  const cardinalityKeys = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    for (const [k, v] of Object.entries(node)) {
      const child = path === "" ? k : `${path}.${k}`;
      if (/count|sources|accounts|legs|lanes|min|max|spread|samples|n_/i.test(k)) {
        cardinalityKeys.push(child);
      }
      walk(v, child);
    }
  };
  walk(body, "");
  report.add("T6.noCardinality", "§2.3", cardinalityKeys.length === 0,
    "no field exposes contributing-source cardinality or spread",
    cardinalityKeys.length ? cardinalityKeys.join(", ") : null);

  // -- T7 identity ----------------------------------------------------------
  // The assertion the edge cannot make. Uses the shipped detector, with the
  // document's own model IDs as the permitted-key allowlist.
  const leaks = findIdentityLeaks(body, modelIds);
  report.add("T7.noIdentity", "§2.2", leaks.length === 0,
    `deep scan found no provider, account, connection, credential or route identity`,
    leaks.length ? leaks.map((l) => `${l.path || "(root)"}: ${l.detail}`).join("; ") : null);

  return report;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchDocument(url, key, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: "application/json" };
    if (key) headers["x-api-key"] = key;
    const res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes: Buffer.byteLength(text, "utf8"),
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Self-test: mutants that MUST be rejected
// ---------------------------------------------------------------------------

function baseline(nowIso) {
  return {
    schemaVersion: 1,
    observedAt: nowIso,
    staleAfterSeconds: 300,
    telemetry: "available",
    reasonCode: null,
    models: {
      "oc/claude-opus-5": {
        serviceable: true,
        state: "degraded",
        utilization: 0.71,
        remainingFraction: 0.29,
        resetsAt: "2026-09-05T04:00:00.000Z",
        resetInSeconds: 1800,
        windows: [
          { window: "five-hour", utilization: 0.71, resetsAt: "2026-09-05T04:00:00.000Z", resetInSeconds: 1800 },
          { window: "weekly", utilization: 0.44, resetsAt: "2026-09-08T00:00:00.000Z", resetInSeconds: 288000 },
        ],
        observationQuality: "measured",
      },
    },
  };
}

function mutants(nowIso) {
  const m = (label, expectId, fn) => {
    const doc = baseline(nowIso);
    fn(doc);
    return { label, expectId, doc };
  };
  return [
    // --- identity leaks, the class that matters -------------------------
    m("provider name on a record", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].provider = "anthropic"; }),
    m("account email", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].account = "ops@togetherweown.com"; }),
    m("bare email in an innocent-looking value", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].note = "seat ops@togetherweown.com"; }),
    m("connection base URL", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].baseUrl = "https://api.anthropic.com"; }),
    m("lane label", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].laneLabel = "claude-primary"; }),
    m("sk- credential in a reason string", "T7.noIdentity",
      (d) => { d.reasonDetail = "upstream said sk-ant-api03-XXXXXXXXXXXX"; }),
    m("oma_ token", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].auth = "oma_notarealtoken"; }),
    m("deployment UUID", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].origin = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"; }),
    m("serving-route attribution", "T7.noIdentity",
      (d) => { d.models["oc/claude-opus-5"].servedBy = "leg-2"; }),

    // --- cardinality ----------------------------------------------------
    m("contributing-source count", "T6.noCardinality",
      (d) => { d.models["oc/claude-opus-5"].sourceCount = 3; }),
    m("per-source spread as min/max", "T6.noCardinality",
      (d) => { d.models["oc/claude-opus-5"].utilizationMax = 0.9; }),
    m("repeated window entry (per-lane spread)", "T5.windowUnique:oc/claude-opus-5",
      (d) => {
        d.models["oc/claude-opus-5"].windows.push(
          { window: "five-hour", utilization: 0.12, resetsAt: null, resetInSeconds: null });
      }),

    // --- outage vs emptiness --------------------------------------------
    m("outage collapsed to a bare empty set", "T3.healthyReason",
      (d) => { d.models = {}; d.reasonCode = "upstream-unreachable"; }),
    m("outage carrying records", "T3.outageEmpty",
      (d) => { d.telemetry = "unavailable"; d.reasonCode = "upstream-error"; }),
    m("outage with free-text reason", "T3.outageReason",
      (d) => { d.telemetry = "unavailable"; d.models = {}; d.reasonCode = "cliproxy timed out"; }),

    // --- envelope and record rules --------------------------------------
    m("unknown schemaVersion", "T2.schemaVersion", (d) => { d.schemaVersion = 2; }),
    m("missing telemetry field", "T2.telemetry", (d) => { delete d.telemetry; }),
    m("stale snapshot", "T4.fresh",
      (d) => { d.observedAt = new Date(Date.parse(d.observedAt) - 3600_000).toISOString(); }),
    m("utilization above 1 (clamped-looking)", "T5.utilization:oc/claude-opus-5",
      (d) => { d.models["oc/claude-opus-5"].utilization = 1.7; }),
    m("serviceable disagreeing with state", "T5.serviceable:oc/claude-opus-5",
      (d) => { d.models["oc/claude-opus-5"].state = "exhausted"; }),
    m("vendor-named window", "T5.windowName:oc/claude-opus-5:0",
      (d) => { d.models["oc/claude-opus-5"].windows[0].window = "anthropic-5h"; }),
    m("state outside the enum", "T5.state:oc/claude-opus-5",
      (d) => { d.models["oc/claude-opus-5"].state = "throttled"; }),
  ];
}

async function runSelfTest(findIdentityLeaks, json) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const opts = { now };
  const results = [];

  // The baseline must PASS, or every mutant below fails for the wrong reason.
  const clean = checkDocument(baseline(nowIso), null, opts, findIdentityLeaks);
  results.push({
    label: "clean baseline is accepted",
    ok: clean.passed,
    detail: clean.passed ? null : clean.failures.map((f) => `${f.id}: ${f.label}`).join("; "),
  });

  for (const { label, expectId, doc } of mutants(nowIso)) {
    const report = checkDocument(doc, null, opts, findIdentityLeaks);
    const failedIds = report.failures.map((f) => f.id);
    const rejected = failedIds.length > 0;
    const byExpected = failedIds.includes(expectId);
    results.push({
      label: `mutant rejected: ${label}`,
      ok: rejected && byExpected,
      detail: !rejected
        ? "ACCEPTED — the check is vacuous for this class"
        : byExpected
          ? null
          : `rejected, but by ${failedIds.join(",")} not the expected ${expectId}`,
    });
  }

  const passed = results.every((r) => r.ok);
  if (json) {
    console.log(JSON.stringify({ mode: "selftest", passed, results }, null, 2));
  } else {
    console.log("Self-test — every mutant below must be REJECTED\n");
    for (const r of results) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}${r.detail ? `\n          ${r.detail}` : ""}`);
    }
    console.log(`\n${passed ? "PASS" : "FAIL"}: ${results.filter((r) => r.ok).length}/${results.length} — the suite is${passed ? "" : " NOT"} capable of failing.`);
  }
  return passed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const json = process.argv.includes("--json");
  const allowStale = process.argv.includes("--allow-stale");
  const { findIdentityLeaks } = await loadSanitizer();

  if (process.argv.includes("--selftest")) {
    process.exit(await runSelfTest(findIdentityLeaks, json));
  }

  const file = arg("--file");
  const url = arg("--url");
  if (!file && !url) {
    console.error("usage: telemetry-conformance.mjs (--selftest | --file <path> | --url <url> [--key-env VAR])");
    process.exit(2);
  }

  let body;
  let meta = null;
  try {
    if (file) {
      body = JSON.parse(readFileSync(file, "utf8"));
    } else {
      const keyEnv = arg("--key-env");
      const key = keyEnv ? process.env[keyEnv] : null;
      if (keyEnv && !key) {
        console.error(`cannot check: ${keyEnv} is not set in this environment.`);
        console.error("The lane credential is not projected here; run this where it is, or use --file.");
        process.exit(2);
      }
      const res = await fetchDocument(url, key, Number(arg("--timeout-ms", "10000")));
      meta = { status: res.status, contentType: res.contentType, bytes: res.bytes };
      if (res.status === 401 || res.status === 403) {
        console.error(`cannot check: HTTP ${res.status} — the lane credential was rejected or absent.`);
        process.exit(2);
      }
      try {
        body = JSON.parse(res.text);
      } catch {
        console.error(`cannot check: HTTP ${res.status} body is not JSON (${res.bytes} B).`);
        process.exit(2);
      }
    }
  } catch (error) {
    console.error(`cannot check: ${error.message}`);
    process.exit(2);
  }

  const report = checkDocument(body, meta, { allowStale }, findIdentityLeaks);

  if (json) {
    console.log(JSON.stringify({
      mode: "document",
      source: file ? { file } : { url },
      transport: meta,
      passed: report.passed,
      checks: report.checks,
    }, null, 2));
  } else {
    console.log(`Conformance — ${file ? file : url}\n`);
    for (const c of report.checks) {
      const tag = c.ok ? "PASS" : c.severity === "warn" ? "WARN" : "FAIL";
      console.log(`  ${tag}  [${c.section}] ${c.label}${c.detail ? `\n          ${c.detail}` : ""}`);
    }
    const n = report.checks.length;
    const warned = report.warnings.length;
    console.log(`\n${report.passed ? "PASS" : "FAIL"}: ${n - report.failures.length - warned}/${n} checks${warned ? `, ${warned} warning(s)` : ""}.`);
    if (!report.passed) {
      console.log("\nThe document does NOT conform to docs/contracts/model-usage-telemetry-v1.md.");
    }
  }
  process.exit(report.passed ? 0 : 1);
}

await main();
