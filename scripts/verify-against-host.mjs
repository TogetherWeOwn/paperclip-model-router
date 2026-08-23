#!/usr/bin/env node
/**
 * Validate the BUILT artifact with the host's own install-time validators.
 *
 * `npm run verify` proves the plugin is internally consistent. This proves the
 * host would accept it, using the host's code rather than a re-implementation
 * of it:
 *
 *   - `pluginManifestV1Schema` from `@paperclipai/shared` is what
 *     `plugin-manifest-validator.ts` runs at install step 3-4 ("read and
 *     validate plugin manifest", "reject incompatible plugin API versions").
 *   - The Ajv construction below is what `plugin-config-validator.ts` runs on
 *     every `POST /api/plugins/:pluginId/config`.
 *
 * Point PAPERCLIP_SHARED at a Paperclip checkout's built shared package to
 * validate against that exact host build instead of the published package:
 *
 *   PAPERCLIP_SHARED=/app/packages/shared/dist/validators/plugin.js \
 *     node scripts/verify-against-host.mjs
 *
 * Exits non-zero on any rejection.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = "tests/fixtures";
let failures = 0;

function report(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

// --- 1. the built manifest, against the host's Zod schema --------------------

const sharedEntry = process.env.PAPERCLIP_SHARED ?? "@paperclipai/shared";
const shared = await import(sharedEntry);
const { pluginManifestV1Schema, PLUGIN_API_VERSION } = shared;

if (!pluginManifestV1Schema) {
  console.error(`${sharedEntry} does not export pluginManifestV1Schema`);
  process.exit(2);
}

const manifest = (await import("../dist/manifest.js")).default;
const parsed = pluginManifestV1Schema.safeParse(manifest);

report(
  parsed.success,
  "built manifest passes the host's pluginManifestV1Schema",
  parsed.success
    ? `${manifest.id} v${manifest.version}`
    : parsed.error.errors
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
);

if (PLUGIN_API_VERSION !== undefined) {
  report(
    manifest.apiVersion === PLUGIN_API_VERSION,
    "manifest apiVersion matches the host's PLUGIN_API_VERSION",
    `manifest=${manifest.apiVersion} host=${PLUGIN_API_VERSION}`,
  );
}

// --- 2. every shipped example config, against the host's Ajv setup -----------

const AjvModule = await import("ajv");
const addFormatsModule = await import("ajv-formats");
const Ajv = AjvModule.default?.default ?? AjvModule.default ?? AjvModule;
const addFormats = addFormatsModule.default?.default ?? addFormatsModule.default ?? addFormatsModule;

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
ajv.addFormat("secret-ref", { validate: () => true });
const validateConfig = ajv.compile(manifest.instanceConfigSchema);

for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".json"))) {
  const config = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  const ok = validateConfig(config);
  report(
    ok,
    `${file} passes the host's instanceConfigSchema validation`,
    ok
      ? ""
      : (validateConfig.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message}`)
          .join("; "),
  );
}

// A pasted credential must be refused at write time, not merely discouraged.
//
// Only the string case was checked here originally, and the string case was
// never the risk: `type: ["object","null"]` already refused it. The risk was an
// OBJECT holding a value. `format: "secret-ref"` does not catch that — the host
// registers it as `ajv.addFormat("secret-ref", { validate: () => true })`, and
// `format` is a string-only keyword in any case — and the host's secret-ref
// extractor ignores any value that is not literally `{ type: "secret_ref" }`,
// so such an object was stored verbatim in the company's config row. TOG-228.
//
// `POST /plugins/:id/config` validates with Ajv and never calls the worker's
// `onValidateConfig` — only the non-persisting `/config/test` does — so this
// schema is the only thing standing between a pasted key and the database.
// Hence these run against the host's own Ajv construction, not only in units.
const credentialAttempts = [
  ["a pasted string", { quotaGate: { apiKeySecretRef: "sk-live-not-a-reference" } }],
  [
    "an object holding a value",
    { quotaGate: { apiKeySecretRef: { apiKey: "sk-live-not-a-reference" } } },
  ],
  [
    "a value smuggled alongside a valid reference",
    {
      quotaGate: {
        apiKeySecretRef: {
          type: "secret_ref",
          secretId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
          value: "sk-live-not-a-reference",
        },
      },
    },
  ],
  [
    "a secret id that is not a Paperclip secret",
    { quotaGate: { apiKeySecretRef: { type: "secret_ref", secretId: "teamclaude" } } },
  ],
];

for (const [label, config] of credentialAttempts) {
  report(
    validateConfig(config) === false,
    `the host validator rejects a credential at the secret-ref field: ${label}`,
  );
}

// A Claude model filed under a non-Claude family must be refused at write time.
//
// TOG-237. The engine is the gate — it classifies on the model id and cannot be
// reconfigured out of the Claude block — but the same argument as above applies
// to the write itself: `POST /plugins/:id/config` validates here and never calls
// `onValidateConfig`, so if this schema accepts the row, the row is persisted and
// the operator is told nothing. Run against the host's own Ajv rather than ours,
// because "our unit test says the schema rejects it" is a claim about our Ajv.
const mislabelAttempts = [
  ["lower case", "claude-opus-5"],
  ["upper case", "CLAUDE_4_5_HAIKU"],
  ["mixed case", "Claude-Sonnet-5"],
  ["vendor prefix", "AnThRoPiC/claude-3"],
];

for (const [label, id] of mislabelAttempts) {
  const config = {
    models: [
      {
        id,
        family: "gpt",
        tier: "frontier",
        quality: 95,
        costPerMTokIn: 15,
        costPerMTokOut: 75,
        contextWindow: 200000,
        providers: ["openrouter"],
      },
    ],
  };
  report(
    validateConfig(config) === false,
    `the host validator rejects a Claude id filed under a non-Claude family: ${label} (${id})`,
  );
}

// ...and a correctly labelled Claude row must still be accepted, or no company
// could configure Claude at all.
report(
  validateConfig({
    models: [
      {
        id: "claude-opus-5",
        family: "claude",
        tier: "frontier",
        quality: 95,
        costPerMTokIn: 15,
        costPerMTokOut: 75,
        contextWindow: 200000,
        providers: ["teamclaude"],
      },
    ],
  }) === true,
  "the host validator accepts a correctly labelled Claude row",
);

// ...and the shape the secret picker actually submits must still be accepted,
// or the quota gate could never be configured at all.
report(
  validateConfig({
    quotaGate: {
      apiKeySecretRef: { type: "secret_ref", secretId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
    },
  }) === true,
  "the host validator accepts a real Paperclip secret reference",
);

// --- 3. the built worker actually loads -------------------------------------

const worker = await import("../dist/worker.js");
report(
  typeof worker.default?.definition?.setup === "function",
  "built worker exports a plugin definition with a setup handler",
);

console.log(`\n${failures === 0 ? "all host-side checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
