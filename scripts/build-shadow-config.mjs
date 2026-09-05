/**
 * TOG-986 step 2 — build and validate the shadow-mode plugin config document.
 *
 * The host's `POST /api/plugins/:pluginId/config` is a FULL-DOCUMENT REPLACE
 * guarded by `assertInstanceAdmin` (server/src/routes/plugins.ts:2287), so an
 * agent cannot apply it. This script does the part an agent CAN do
 * deterministically: merge `capacityRouting` into whatever the operator's
 * current config document is, and run the merged result through the host's own
 * `validateInstanceConfig` — the exact function the route calls at line 2317 —
 * so the operator never pastes a document the host will reject.
 *
 * Usage:
 *   node scripts/build-shadow-config.mjs <current-config.json> [--enabled=false]
 *
 * `<current-config.json>` is the `configJson` object from
 * `GET /api/plugins/togetherweown.paperclip-model-router/config?companyId=...`.
 * Pass `--enabled=false` to emit the rollback document instead.
 *
 * Prints the full request body for the operator to POST. Exits non-zero if the
 * merged document does not validate.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID = "togetherweown.paperclip-model-router";
const COMPANY_ID = "ef993a7e-5ea7-445f-ba88-27a6a2690c3a";

// The block TOG-986 specifies. `mode` is pinned to "shadow": "enforce" is
// schema-valid and the host would accept it, but TOG-901/916 (serving identity)
// and TOG-251 (measured quality floors) are open gates. The guard is
// procedural, so it lives here as a literal rather than a parameter.
const SHADOW_BLOCK = {
  enabled: true,
  mode: "shadow",
  unknownTelemetry: "fail-closed",
  conserveUtilization: 0.6,
  avoidUtilization: 0.8,
  maxSnapshotAgeMs: 300000,
  sources: [],
};

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const currentPath = args.find((a) => !a.startsWith("--"));
const rollback = args.includes("--enabled=false");
if (!currentPath) fail("usage: node scripts/build-shadow-config.mjs <current-config.json> [--enabled=false]");
if (!existsSync(currentPath)) fail(`${currentPath} does not exist`);

let current;
try {
  const raw = JSON.parse(readFileSync(currentPath, "utf8"));
  // Accept either the bare configJson object or the whole PluginConfig record.
  current = raw && typeof raw.configJson === "object" && raw.configJson !== null ? raw.configJson : raw;
} catch (error) {
  fail(`${currentPath} is not valid JSON: ${error.message}`);
}
if (!current || typeof current !== "object" || Array.isArray(current)) {
  fail("current config must be a JSON object");
}

// A bare capacityRouting-only document is rejected by the schema
// ("must have required property 'upstream'"), which is exactly why this is a
// merge and not a replace. Refuse loudly rather than emitting a doc that strips
// the operator's existing keys.
if (!("upstream" in current)) {
  fail(
    "the supplied current config has no `upstream` key — that is almost certainly " +
      "not the live document. Re-fetch it with GET /api/plugins/" +
      PLUGIN_ID +
      "/config?companyId=" +
      COMPANY_ID,
  );
}

const configJson = {
  ...current,
  capacityRouting: rollback
    ? { ...(current.capacityRouting ?? SHADOW_BLOCK), enabled: false }
    : SHADOW_BLOCK,
};

// --- validate with the host's own validator ---------------------------------

async function loadHostValidator() {
  const hostRoot = process.env.PAPERCLIP_HOST_ROOT ?? "/app";
  const serverDist = join(hostRoot, "server", "dist");
  const sharedDist = join(hostRoot, "packages", "shared", "dist");
  const validatorPath = join(serverDist, "services", "plugin-config-validator.js");
  if (!existsSync(validatorPath)) {
    return { ok: false, reason: `${validatorPath} is missing — build the host checkout first` };
  }
  if (typeof registerHooks !== "function") {
    return { ok: false, reason: `node ${process.version} has no module.registerHooks (needs >= 22.15)` };
  }
  // The host's TS sources import "@paperclipai/db"/"@paperclipai/shared" by bare
  // specifier; map them onto the built dist so the import resolves.
  const SHARED = "@paperclipai/shared";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== SHARED && !specifier.startsWith(`${SHARED}/`)) {
        return nextResolve(specifier, context);
      }
      const subpath = specifier === SHARED ? "index" : specifier.slice(SHARED.length + 1);
      const candidates = [join(sharedDist, `${subpath}.js`), join(sharedDist, subpath, "index.js")];
      const target = candidates.find((candidate) => existsSync(candidate));
      if (!target) return nextResolve(specifier, context);
      return { url: pathToFileURL(target).href, shortCircuit: true };
    },
  });
  try {
    const mod = await import(pathToFileURL(validatorPath).href);
    return { ok: true, validateInstanceConfig: mod.validateInstanceConfig, hostRoot };
  } catch (error) {
    return { ok: false, reason: `importing the host validator failed: ${error.message}` };
  }
}

const manifestPath = resolve(
  process.env.PAPERCLIP_ROUTER_DIST ?? "/paperclip/plugin-packages-root/model-router-0.4.0",
  "dist/manifest.js",
);
if (!existsSync(manifestPath)) fail(`${manifestPath} is missing — stage the artifact first`);
const manifest = (await import(pathToFileURL(manifestPath).href)).default;
const schema = manifest?.instanceConfigSchema;
if (!schema || Object.keys(schema).length === 0) fail("manifest declares no instanceConfigSchema");

const host = await loadHostValidator();
if (!host.ok) fail(`cannot run the host's validator: ${host.reason}`);

const result = host.validateInstanceConfig(configJson, schema);
if (!result.valid) {
  console.error("merged document does NOT satisfy the plugin's instanceConfigSchema:");
  console.error(JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

// Guard the procedural gate mechanically, not just by convention.
if (configJson.capacityRouting.mode !== "shadow") {
  fail("refusing to emit a document whose capacityRouting.mode is not \"shadow\"");
}

const body = { companyId: COMPANY_ID, configJson };
console.error(
  `validated against ${host.hostRoot} (server/dist/services/plugin-config-validator.js) — OK\n` +
    `mode=${configJson.capacityRouting.mode} enabled=${configJson.capacityRouting.enabled}\n` +
    `preserved top-level keys: ${Object.keys(current).join(", ")}\n`,
);
console.log(JSON.stringify(body, null, 2));
