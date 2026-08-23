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
report(
  validateConfig({ quotaGate: { apiKeySecretRef: "sk-live-pasted-key" } }) === false,
  "a raw credential at the secret-ref field is rejected by the host validator",
);

// --- 3. the built worker actually loads -------------------------------------

const worker = await import("../dist/worker.js");
report(
  typeof worker.default?.definition?.setup === "function",
  "built worker exports a plugin definition with a setup handler",
);

console.log(`\n${failures === 0 ? "all host-side checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
