#!/usr/bin/env node
// TOG-974: capture a live serving fingerprint from the installed router.
//
// Serving identity for this purpose is (outcome, modelId, effectiveTier) per
// fixed descriptor. Run it before enabling capacity shadow mode and again
// after; the two fingerprints MUST be identical, because shadow mode is
// defined as observe-only. Anything that differs is a shadow-mode leak into
// serving and is a stop-ship.
//
//   node scripts/capture-serving-baseline.mjs > baseline.json
//   node scripts/capture-serving-baseline.mjs > shadow.json
//   node scripts/capture-serving-baseline.mjs --diff baseline.json shadow.json
//
// Needs PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.

import { readFileSync } from "node:fs";

const PLUGIN_ID = "f4ae898a-f839-4f64-9ff9-cf2e6287acc8";

// Fixed descriptors spanning the tier ladder and the gate paths. Deliberately
// hard-coded: a fingerprint you regenerate from live state proves nothing.
const CASES = [
  { name: "default-no-signals", task: { summary: "probe", estimatedInputTokens: 50, estimatedOutputTokens: 16 } },
  { name: "small-cheap", task: { summary: "rename a variable", estimatedInputTokens: 400, estimatedOutputTokens: 50, signals: { complexity: 0.05 } } },
  { name: "standard-mid", task: { summary: "add a unit test for the normalizer", estimatedInputTokens: 8000, estimatedOutputTokens: 800, signals: { complexity: 0.5 } } },
  { name: "large-complex", task: { summary: "deep architecture review of the capacity boundary", estimatedInputTokens: 90000, estimatedOutputTokens: 4000, requiredCapabilities: ["tools"], signals: { complexity: 0.9 } } },
  { name: "long-context", task: { summary: "summarize the full transcript", estimatedInputTokens: 300000, estimatedOutputTokens: 2000, requiredContextTokens: 250000 } },
  { name: "rule0-deterministic", task: { summary: "what is the current git status", estimatedInputTokens: 100, estimatedOutputTokens: 20 } },
];

function base() {
  const u = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/$/, "");
  return u.replace(/\/api$/, "");
}

async function decide(task) {
  const url = `${base()}/api/plugins/${PLUGIN_ID}/api/invoke?companyId=${process.env.PAPERCLIP_COMPANY_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}` },
    // maxOutputTokens is deliberately tiny: we want the decision, not the tokens.
    body: JSON.stringify({ messages: [{ role: "user", content: "ok" }], maxOutputTokens: 8, task }),
  });
  const body = await res.json();
  const d = body.decision ?? {};
  return {
    http: res.status,
    // serving identity — must not move under shadow mode
    serving: { outcome: body.outcome ?? null, modelId: d.modelId ?? null, effectiveTier: d.effectiveTier ?? null },
    // observability — expected to move when shadow mode turns on
    capacity: d.capacity ?? null,
    hasCapacityKey: Object.prototype.hasOwnProperty.call(d, "capacity"),
  };
}

// Credential material must never reach a decision payload. Checked on every
// capture rather than once, so a config change that adds a source with a key
// cannot quietly start leaking it.
const FORBIDDEN = [/sk-[A-Za-z0-9]/, /oma_[A-Za-z0-9]/, /\bBearer\s+\S/, /"api_?[kK]ey"/, /"accountId"/, /bestLaneFor/];

function scanForSecrets(sample) {
  const blob = JSON.stringify(sample);
  return FORBIDDEN.filter((re) => re.test(blob)).map(String);
}

if (process.argv[2] === "--diff") {
  const a = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const b = JSON.parse(readFileSync(process.argv[4], "utf8"));
  let drift = 0;
  for (const name of Object.keys(a.cases)) {
    const x = JSON.stringify(a.cases[name].serving);
    const y = JSON.stringify(b.cases[name]?.serving);
    const same = x === y;
    if (!same) drift += 1;
    console.log(`${same ? "SAME" : "DRIFT"} ${name}\n  before ${x}\n  after  ${y}`);
  }
  console.log(`\ncapacity.mode: ${a.cases["default-no-signals"].capacity?.mode} -> ${b.cases["default-no-signals"].capacity?.mode}`);
  console.log(`serving drift: ${drift}/${Object.keys(a.cases).length}`);
  process.exit(drift === 0 ? 0 : 1);
}

const cases = {};
for (const c of CASES) cases[c.name] = await decide(c.task);
const leaks = scanForSecrets(cases);
console.log(JSON.stringify({ pluginId: PLUGIN_ID, cases, secretScan: { patternsMatched: leaks, clean: leaks.length === 0 } }, null, 2));
