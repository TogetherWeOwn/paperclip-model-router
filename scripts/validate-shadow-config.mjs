#!/usr/bin/env node
// TOG-974: validate the proposed shadow-mode config against the schema the
// INSTALLED plugin actually carries — not the schema in src/, which is only
// the schema we think is installed.
//
//   node scripts/validate-shadow-config.mjs [/path/to/installed]
//
// Answers three questions the config POST would otherwise answer destructively:
//   1. does the 0.4.0 schema still tolerate the existing `rule0` key?
//   2. is the shadow-mode capacityRouting block valid?
//   3. does `enforce` get rejected by the schema, or only by policy?

import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = process.argv[2] ?? "/paperclip/plugin-packages-root/model-router-0.4.0";
const manifest = (await import(`${root}/dist/manifest.js`)).default;
const schema = manifest.instanceConfigSchema;

const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: false });
addFormats(ajv);
// `secret-ref` is a host-supplied format; accept any object here since we are
// checking config shape, not secret resolution.
ajv.addFormat("secret-ref", () => true);
const validate = ajv.compile(schema);

// The live company config keys, per the operator's report on TOG-974.
const LIVE_KEYS = ["rule0", "budget", "models", "routing", "tiering", "upstream", "taskClasses"];

const SHADOW_BLOCK = {
  enabled: true,
  mode: "shadow",
  unknownTelemetry: "fail-closed",
  conserveUtilization: 0.6,
  avoidUtilization: 0.8,
  maxSnapshotAgeMs: 300000,
  sources: [],
};

// Minimal stand-in for the live document. `upstream` is the only required root
// key, but it has its own required triple — get that wrong and every negative
// control below "passes" for the wrong reason.
const baseDoc = () => ({
  upstream: {
    protocol: "openai-chat-completions",
    baseUrl: "https://router.infextion.net",
    credentialSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000000" },
  },
  rule0: { enabled: true },
  budget: {},
  routing: {},
  tiering: {},
  models: [],
  taskClasses: [],
});

function check(label, doc, expectValid) {
  const ok = validate(doc);
  const status = ok === expectValid ? "PASS" : "FAIL";
  console.log(`${status}  ${label}  (valid=${ok}, expected=${expectValid})`);
  if (!ok) for (const e of validate.errors ?? []) console.log(`        ${e.instancePath || "/"} ${e.message}`);
  return ok === expectValid;
}

const results = [];
console.log(`manifest version ${manifest.version}; root props ${Object.keys(schema.properties).join(", ")}\n`);

// Q1 — the operator's open question. `rule0` IS a declared property in 0.4.0.
results.push(check("live-shaped doc incl. rule0, no capacityRouting (today's state)", baseDoc(), true));

// Q2 — the block we intend to POST.
results.push(check("live doc + capacityRouting shadow block", { ...baseDoc(), capacityRouting: SHADOW_BLOCK }, true));

// Q3 — enforce is schema-valid. The guard against it is procedural only.
results.push(check("enforce mode (schema-valid; blocked by POLICY, not schema)", { ...baseDoc(), capacityRouting: { ...SHADOW_BLOCK, mode: "enforce" } }, true));

// Negative controls: prove the validator can actually reject.
results.push(check("capacityRouting-only doc (missing required upstream)", { capacityRouting: SHADOW_BLOCK }, false));
results.push(check("unknown mode value", { ...baseDoc(), capacityRouting: { ...SHADOW_BLOCK, mode: "observe" } }, false));
results.push(check("unknown key inside capacityRouting", { ...baseDoc(), capacityRouting: { ...SHADOW_BLOCK, bestLaneFor: true } }, false));
results.push(check("unknown key at document root", { ...baseDoc(), notARealKey: 1 }, false));
results.push(check("utilization out of range", { ...baseDoc(), capacityRouting: { ...SHADOW_BLOCK, avoidUtilization: 1.5 } }, false));
// The SSRF guard on telemetry sources: private addresses must be refused.
results.push(check("private-address telemetry source (SSRF guard)", { ...baseDoc(), capacityRouting: { ...SHADOW_BLOCK, sources: [{ id: "s", statusUrl: "https://192.168.1.9/status", modelIds: ["m"], windows: [{ name: "w", utilizationFields: ["u"] }] }] } }, false));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks behaved as expected`);
console.log(`LIVE_KEYS all declared in schema: ${LIVE_KEYS.every((k) => k in schema.properties)}`);
process.exit(failed === 0 ? 0 : 1);
