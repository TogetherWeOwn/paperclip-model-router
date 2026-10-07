#!/usr/bin/env node
/**
 * Validate the BUILT artifact with the host's own install-time validators.
 *
 * `npm run verify` proves the plugin is internally consistent. This proves the
 * host would accept it, using the host's code rather than a re-implementation
 * of it. `plugin-loader.ts` runs these gates in order before a plugin row is
 * written; this script walks the same list:
 *
 *   step 3-4  `pluginManifestV1Schema` from `@paperclipai/shared`, then the
 *             apiVersion gate — `plugin-manifest-validator.ts`.
 *   step 5    `capabilityValidator.validateManifestCapabilities(manifest)` —
 *             declared features must be covered by declared capabilities.
 *   step 5b   `assertPageRoutePathsAvailable(manifest)` — page-route collision.
 *   step 6    `getMinimumHostVersion(manifest)` vs the running server.
 *
 *   ...plus the Ajv construction from `plugin-config-validator.ts`, which is
 *   what runs on every `POST /api/plugins/:pluginId/config`.
 *
 * Two independent pointers into a Paperclip checkout, both optional:
 *
 *   PAPERCLIP_SHARED  a built module exporting `pluginManifestV1Schema`.
 *   PAPERCLIP_HOST    the checkout ROOT (e.g. `/app`). Unlocks steps 5, 5b and
 *                     6 against the host's compiled `server/dist`, which is the
 *                     only way to run the real `FEATURE_CAPABILITIES` table
 *                     rather than a copy of it. Auto-detected at `/app`.
 *
 *   PAPERCLIP_HOST=/app \
 *     PAPERCLIP_SHARED=/app/packages/shared/dist/validators/plugin.js \
 *     node scripts/verify-against-host.mjs
 *
 * Without PAPERCLIP_HOST — CI, where there is no checkout — steps 5/5b/6 fall
 * back to the MIRROR implementations below and say so on every line. A mirror
 * can drift, so when the host IS reachable the mirror is re-derived against it
 * and disagreement is a FAIL: the copy is never trusted on its own for long.
 *
 * A check that cannot run announces itself as SKIP and is counted in the
 * summary. Silence is the failure mode this script exists to remove — an
 * apiVersion check that quietly evaporated because the module it read the
 * constant from did not export it is what prompted half of this file.
 *
 * TOG-1070: counting a SKIP was not enough. When a host checkout IS reachable,
 * every check here is supposed to run, so a SKIP means something stopped
 * resolving and the gate is reporting success without having executed. Under
 * `probePolicy().strict` — i.e. whenever PAPERCLIP_HOST is set or a checkout is
 * found at /app — a skip is a FAILURE. Without a host it stays a skip, because
 * CI has no checkout and the mirror fallbacks are the designed behaviour there.
 *
 * Exits non-zero on any rejection, and on any skip when strict.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describePolicy, probePolicy, writeReceipt } from "./lib/host-probes.mjs";

const FIXTURES = "tests/fixtures";
const policy = probePolicy();
let failures = 0;
let skips = 0;
let checksRun = 0;
let unrunnable = 0;

function report(ok, label, detail = "") {
  checksRun += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

/**
 * A check that could have run here and did not.
 *
 * Strict turns this into a failure rather than suppressing the line: the label
 * and reason are the diagnostic, and losing them to make room for a FAIL would
 * throw away the only thing that says WHAT stopped resolving.
 */
function skip(label, reason) {
  skips += 1;
  if (policy.strict) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${reason}\n      (a host checkout is present, so this check was expected to run — see ${"ALLOW_HOST_PROBE_SKIP"})`);
    return;
  }
  console.log(`SKIP  ${label}\n      ${reason}`);
}

/**
 * A check that needs something no build ever has — a live instance and its
 * database. Never a failure: strict mode is about checks that SHOULD have run,
 * and no amount of fixing this checkout makes this one runnable.
 */
function skipUnrunnable(label, reason) {
  unrunnable += 1;
  console.log(`N/A   ${label}\n      ${reason}`);
}

function note(text) {
  console.log(`      ${text}`);
}

// --- 0. the host checkout, if one is reachable ------------------------------

/**
 * Load the host's compiled install-time services.
 *
 * `server/dist/**` is plain JS and would import cleanly but for one thing: in a
 * dev checkout `@paperclipai/shared` resolves through the workspace link to
 * `packages/shared/src/index.ts`, and node cannot load TypeScript. A resolve
 * hook redirects that specifier to the built `packages/shared/dist` beside it,
 * which is the same code the server runs. Nothing is stubbed or patched — the
 * modules that come back are the host's.
 *
 * Returns `{ ok: false, reason }` rather than throwing: no checkout is the
 * normal case in CI, and every caller degrades to a mirror or a SKIP.
 */
async function loadHostServices() {
  const explicit = process.env.PAPERCLIP_HOST;
  const hostRoot = explicit ? resolve(explicit) : existsSync("/app/server/dist") ? "/app" : null;

  if (!hostRoot) {
    return { ok: false, reason: "PAPERCLIP_HOST is not set and no checkout was found at /app" };
  }

  const serverDist = join(hostRoot, "server", "dist", "services");
  const sharedDist = join(hostRoot, "packages", "shared", "dist");
  for (const required of [
    join(serverDist, "plugin-capability-validator.js"),
    join(serverDist, "plugin-manifest-validator.js"),
    join(sharedDist, "index.js"),
  ]) {
    if (!existsSync(required)) {
      return { ok: false, reason: `${required} is missing — build the host checkout first` };
    }
  }

  // `module.registerHooks` is node >= 22.15. Older runtimes get the mirror.
  if (typeof registerHooks !== "function") {
    return { ok: false, reason: `node ${process.version} has no module.registerHooks (needs >= 22.15)` };
  }

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
    const { pluginCapabilityValidator } = await import(
      pathToFileURL(join(serverDist, "plugin-capability-validator.js")).href
    );
    const { pluginManifestValidator } = await import(
      pathToFileURL(join(serverDist, "plugin-manifest-validator.js")).href
    );
    return {
      ok: true,
      hostRoot,
      capabilityValidator: pluginCapabilityValidator(),
      manifestValidator: pluginManifestValidator(),
    };
  } catch (error) {
    return { ok: false, reason: `importing the host's services failed: ${error.message}` };
  }
}

const host = await loadHostServices();
console.log(
  host.ok
    ? `host checkout: ${host.hostRoot} (steps 5, 5b and 6 run the host's own code)`
    : `host checkout: none — ${host.reason}\n      steps 5, 5b and 6 run this file's MIRROR of them`,
);
console.log(`${describePolicy(policy)}\n`);

// Asking for a host and not getting one is the TOG-1070 shape at its most
// direct: the run degrades to mirrors and reports success, having proved
// nothing about the host it was pointed at. Strict makes it a failure here
// rather than letting it surface as a scatter of skips further down.
if (policy.strict && !host.ok) {
  report(false, "the requested host checkout loaded", host.reason);
}

// --- 1. the built manifest, against the host's Zod schema --------------------

const sharedEntry = process.env.PAPERCLIP_SHARED ?? "@paperclipai/shared";
const shared = await import(sharedEntry);
const { pluginManifestV1Schema } = shared;

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

// --- 2. apiVersion (install step 4) -----------------------------------------

// This check used to read `PLUGIN_API_VERSION` off whatever PAPERCLIP_SHARED
// pointed at and do nothing at all when the export was absent — no PASS, no
// FAIL, no line. The documented pointer,
// `packages/shared/dist/validators/plugin.js`, is exactly such a module: it has
// the schema and not the constant, which lives in `shared/dist/constants.js`.
// So the more precisely you aimed the script at a real host, the more of it
// silently switched off. Now the constant is hunted down through every module
// that plausibly carries it, and a genuine miss prints SKIP.

/**
 * Find `PLUGIN_API_VERSION` without assuming which module the caller aimed at.
 *
 * A file path gets its siblings tried too: `dist/validators/plugin.js` is one
 * `../` away from the `dist/constants.js` and `dist/index.js` that do export it.
 */
async function resolvePluginApiVersion() {
  const candidates = [sharedEntry];
  if (sharedEntry.startsWith(".") || sharedEntry.startsWith("/")) {
    const entryDir = dirname(resolve(sharedEntry));
    candidates.push(
      join(entryDir, "constants.js"),
      join(entryDir, "index.js"),
      join(entryDir, "..", "constants.js"),
      join(entryDir, "..", "index.js"),
    );
    if (sharedEntry !== "@paperclipai/shared") candidates.push("@paperclipai/shared");
  }
  if (host.ok) {
    const sharedDist = join(host.hostRoot, "packages", "shared", "dist");
    candidates.push(join(sharedDist, "constants.js"), join(sharedDist, "index.js"));
  }
  candidates.push("@paperclipai/plugin-sdk");

  for (const candidate of candidates) {
    const specifier = candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate;
    try {
      const module = await import(specifier);
      if (module.PLUGIN_API_VERSION !== undefined) {
        return { version: module.PLUGIN_API_VERSION, from: candidate };
      }
    } catch {
      // A candidate that does not exist or does not load is not an error; it is
      // simply not where the constant lives in this layout.
    }
  }
  return { version: undefined, from: null, tried: candidates };
}

const apiVersion = await resolvePluginApiVersion();

if (apiVersion.version === undefined) {
  skip(
    "manifest apiVersion matches the host's PLUGIN_API_VERSION",
    `no module in the resolution chain exported PLUGIN_API_VERSION. Tried: ${apiVersion.tried.join(", ")}`,
  );
} else {
  report(
    manifest.apiVersion === apiVersion.version,
    "manifest apiVersion matches the host's PLUGIN_API_VERSION",
    `manifest=${manifest.apiVersion} host=${apiVersion.version} (from ${apiVersion.from})`,
  );
}

// The constant is the plugin author's view. The gate the host actually applies
// at step 4 is `manifestValidator.getSupportedVersions()`, which is a SET — a
// host can support more than one apiVersion at once, and equality with a single
// constant would be the wrong question the moment it does.
if (host.ok) {
  const supported = host.manifestValidator.getSupportedVersions();
  report(
    supported.includes(manifest.apiVersion),
    "the host's manifest validator accepts this apiVersion (install step 4)",
    `manifest=${manifest.apiVersion} supported=[${supported.join(", ")}]`,
  );
} else {
  skip(
    "the host's manifest validator accepts this apiVersion (install step 4)",
    "getSupportedVersions() lives in server/dist and needs PAPERCLIP_HOST",
  );
}

// --- 3. declared features vs declared capabilities (install step 5) ---------

// `plugin-loader.ts:1246`. Every feature block in the manifest implies a
// capability; declaring the block without the capability fails the install with
// "Missing required capabilities for declared features". TOG-228 removed three
// capabilities from this manifest on a least-privilege argument, and this is
// the gate that decides whether that argument went one capability too far.
//
// Not a duplicate of the schema check above, though it looks like one. The Zod
// schema does carry `Capability 'X' is required when Y are declared` refinements
// for the top-level feature blocks — so for `tools` the two gates agree — but it
// has no such rule for `ui.slots` or `launchers`. A manifest declaring a
// `dashboardWidget` slot without `ui.dashboardWidget.register` parses clean and
// is rejected here and nowhere else. That is the half of step 5 which is load
// bearing, and it is the half that goes live the first time this plugin grows a
// UI contribution.
//
// The mirror below is a copy of the host's three tables. It exists so CI has
// coverage without a checkout, and it is only ever trusted provisionally: when
// a host IS reachable, `capabilityDrift` re-derives every entry against the
// real validator and a disagreement fails the run.

const FEATURE_CAPABILITIES = {
  tools: "agent.tools.register",
  jobs: "jobs.schedule",
  webhooks: "webhooks.receive",
  database: "database.namespace.migrate",
  environmentDrivers: "environment.drivers.register",
  agents: "agents.managed",
  projects: "projects.managed",
  routines: "routines.managed",
  objectReferences: "external.objects.detect",
};

const UI_SLOT_CAPABILITIES = {
  appShellOverlay: "ui.action.register",
  organizationSwitcher: "ui.sidebar.register",
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  appShellOverlay: "ui.action.register",
  organizationSwitcher: "ui.sidebar.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  commentContextMenuItem: "ui.action.register",
  settingsPage: "instance.settings.register",
  companySettingsPage: "instance.settings.register",
  routeSidebar: "ui.sidebar.register",
};

const LAUNCHER_PLACEMENT_CAPABILITIES = {
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  commentContextMenuItem: "ui.action.register",
  settingsPage: "instance.settings.register",
};

/** MIRROR of `pluginCapabilityValidator().validateManifestCapabilities`. */
function mirrorValidateManifestCapabilities(candidate) {
  const declared = new Set(candidate.capabilities ?? []);
  const missing = [];
  const need = (capability) => {
    if (!declared.has(capability) && !missing.includes(capability)) missing.push(capability);
  };

  for (const [feature, capability] of Object.entries(FEATURE_CAPABILITIES)) {
    const value = candidate[feature];
    if (Array.isArray(value) && value.length > 0) need(capability);
  }

  // `objectReferences` is the one feature that costs two capabilities.
  if ((candidate.objectReferences?.length ?? 0) > 0) {
    need("external.objects.detect");
    need("external.objects.read");
  }

  for (const slot of candidate.ui?.slots ?? []) {
    const capability = UI_SLOT_CAPABILITIES[slot.type];
    if (capability) need(capability);
  }

  for (const launcher of [...(candidate.launchers ?? []), ...(candidate.ui?.launchers ?? [])]) {
    const capability = LAUNCHER_PLACEMENT_CAPABILITIES[launcher.placementZone];
    if (capability) need(capability);
  }

  return { allowed: missing.length === 0, missing, pluginId: candidate.id };
}

const validateCapabilities = host.ok
  ? (candidate) => host.capabilityValidator.validateManifestCapabilities(candidate)
  : mirrorValidateManifestCapabilities;
const capabilitySource = host.ok ? "host" : "MIRROR";

const capabilityResult = validateCapabilities(manifest);
report(
  capabilityResult.allowed,
  `declared capabilities cover every declared feature — install step 5 [${capabilitySource}]`,
  capabilityResult.allowed
    ? `${manifest.capabilities.length} declared`
    : `missing: ${capabilityResult.missing.join(", ")}`,
);

// The gate above only proves the manifest is currently self-consistent. It says
// nothing about whether the gate has teeth — a manifest that declared no
// features at all would sail through it. So ask the validator, rather than this
// file, which capabilities the declared features actually require: strip the
// capability list and read back what it demands. Then remove each one from the
// real manifest and require a rejection.
const requiredByFeatures = validateCapabilities({ ...manifest, capabilities: [] }).missing;

report(
  requiredByFeatures.length > 0,
  `the manifest declares at least one capability-bearing feature [${capabilitySource}]`,
  requiredByFeatures.length > 0
    ? `feature-required: ${requiredByFeatures.join(", ")}`
    : "no declared feature requires a capability, so step 5 cannot reject this manifest however it is edited",
);

for (const capability of requiredByFeatures) {
  const withoutIt = {
    ...manifest,
    capabilities: manifest.capabilities.filter((declared) => declared !== capability),
  };
  report(
    validateCapabilities(withoutIt).allowed === false,
    `dropping '${capability}' fails step 5 [${capabilitySource}]`,
  );
}

// Mirror vs host, entry by entry. Only runs with a checkout — which is the
// point: the mirror is re-earned whenever anyone runs this against a real host,
// so the copy in this file cannot rot unnoticed for a whole release.
//
// The probe set is deliberately NOT `Object.keys(...)` of the mirror. Ask the
// mirror which cases to test and deleting one of its rows deletes the test for
// that row: the run stays green and only the "N mappings agree" count moves,
// which nobody reads. So the slot and launcher probes come from the host's own
// `PLUGIN_UI_SLOT_TYPES` / `PLUGIN_LAUNCHER_PLACEMENT_ZONES` enumerations, and
// the feature probes are the union of the mirror's keys with every array-valued
// top-level key of the real manifest. A row the mirror drops is still probed; a
// slot type the host ADDS is probed the first time this runs against that host.
//
// What survives: a top-level FEATURE key the host adds which this manifest does
// not declare and the mirror has never heard of. It is unprobeable without the
// host exporting FEATURE_CAPABILITIES, and it is also the harmless case — an
// undeclared feature demands nothing. It becomes probed the moment the manifest
// declares it, which is the moment it could fail an install.
if (host.ok) {
  const slotTypes = new Set(Object.keys(UI_SLOT_CAPABILITIES));
  const placementZones = new Set(Object.keys(LAUNCHER_PLACEMENT_CAPABILITIES));
  const featureKeys = new Set(Object.keys(FEATURE_CAPABILITIES));
  for (const [key, value] of Object.entries(manifest)) {
    if (Array.isArray(value) && value.length > 0) featureKeys.add(key);
  }

  let enumerationSource = "the mirror's own keys (host enumerations unavailable)";
  try {
    const constants = await import(
      pathToFileURL(join(host.hostRoot, "packages", "shared", "dist", "constants.js")).href
    );
    for (const type of constants.PLUGIN_UI_SLOT_TYPES ?? []) slotTypes.add(type);
    for (const zone of constants.PLUGIN_LAUNCHER_PLACEMENT_ZONES ?? []) placementZones.add(zone);
    if (constants.PLUGIN_UI_SLOT_TYPES) enumerationSource = "the host's exported enumerations";
  } catch {
    // Fall through on the mirror's keys alone, having said so.
  }

  const probes = [
    ...[...featureKeys].map((feature) => [`feature '${feature}'`, { [feature]: [{}] }]),
    ...[...slotTypes].map((type) => [`ui slot '${type}'`, { ui: { slots: [{ type, routePath: "probe" }] } }]),
    ...[...placementZones].map((zone) => [`launcher zone '${zone}'`, { launchers: [{ placementZone: zone }] }]),
  ];

  const drifted = [];
  const format = (list) => [...list].sort().join("+") || "(none)";
  for (const [label, shape] of probes) {
    const candidate = { id: "capability-drift-probe", capabilities: [], ...shape };
    const fromHost = format(host.capabilityValidator.validateManifestCapabilities(candidate).missing);
    const fromMirror = format(mirrorValidateManifestCapabilities(candidate).missing);
    if (fromHost !== fromMirror) drifted.push(`${label}: host=${fromHost} mirror=${fromMirror}`);
  }

  report(
    drifted.length === 0,
    "this file's MIRROR of the capability tables still matches the host's",
    drifted.length === 0
      ? `${probes.length} mappings agree, enumerated from ${enumerationSource}`
      : drifted.join("; "),
  );
}

// --- 4. page route paths (install step 5b) ----------------------------------

// `assertPageRoutePathsAvailable`. Two rules, and only one of them can be
// checked from here:
//
//   a. duplicate `routePath` values WITHIN this manifest — pure manifest data,
//      checked below.
//   b. collision with an ALREADY-INSTALLED plugin — needs `registry.listInstalled()`,
//      i.e. a live instance and its database. Announced as SKIP, never faked.
//
// This plugin declares no page routes today, so (a) has nothing to reject. That
// makes it exactly the kind of check that is written once and silently stops
// meaning anything. The synthetic probe keeps it honest: it proves the detector
// still fires, so the day a page slot is added the guard is known to be live
// rather than assumed to be.

/** MIRROR of `getDeclaredPageRoutePaths` in `plugin-loader.ts`. */
function declaredPageRoutePaths(candidate) {
  return (candidate.ui?.slots ?? [])
    .filter((slot) => slot.type === "page" && typeof slot.routePath === "string" && slot.routePath.length > 0)
    .map((slot) => slot.routePath);
}

const routePaths = declaredPageRoutePaths(manifest);
report(
  new Set(routePaths).size === routePaths.length,
  "no duplicate page routePath values in the manifest [MIRROR]",
  routePaths.length === 0
    ? "none declared — this plugin contributes no page routes"
    : routePaths.join(", "),
);

report(
  new Set(declaredPageRoutePaths({ ui: { slots: [
    { type: "page", routePath: "/model-router" },
    { type: "page", routePath: "/model-router" },
  ] } })).size === 1,
  "the duplicate-routePath detector fires on a synthetic collision [MIRROR]",
);

if (routePaths.length > 0) {
  skipUnrunnable(
    "page routePaths do not collide with an installed plugin",
    "the host compares against registry.listInstalled(); that needs a live instance, not a build",
  );
}

// --- 5. minimum host version (install step 6) -------------------------------

// `compareSemver(hostVersion, getMinimumHostVersion(manifest)) < 0` rejects the
// install. Two traps worth naming, because both fail at install and not here:
//
//   - `compareSemver` THROWS on a version it cannot parse, so a typo'd
//     `minimumHostVersion` is an install-time crash, not a comparison.
//   - the host's `hostVersion` defaults to "0.0.0" when the server was started
//     without one. Against that default, any declared minimum above 0.0.0 loses.

/** MIRROR of `parseSemver` / `compareIdentifiers` / `compareSemver`. */
function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left, right) {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);
  if (leftIsNumeric && rightIsNumeric) return Number(left) - Number(right);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Invalid semver comparison: '${left}' vs '${right}'`);

  const core = ["major", "minor", "patch"].map((key) => a[key] - b[key]).find((delta) => delta !== 0);
  if (core) return core;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const maxLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left_ = a.prerelease[index];
    const right_ = b.prerelease[index];
    if (left_ === undefined) return -1;
    if (right_ === undefined) return 1;
    const diff = compareIdentifiers(left_, right_);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** MIRROR of `getMinimumHostVersion`: the legacy field is still honoured. */
const minimumHostVersion = manifest.minimumHostVersion ?? manifest.minimumPaperclipVersion;

function resolveTargetHostVersion() {
  if (process.env.PAPERCLIP_HOST_VERSION) {
    return { version: process.env.PAPERCLIP_HOST_VERSION, from: "PAPERCLIP_HOST_VERSION" };
  }
  if (host.ok) {
    const packageJson = join(host.hostRoot, "server", "package.json");
    if (existsSync(packageJson)) {
      const { version } = JSON.parse(readFileSync(packageJson, "utf8"));
      // An approximation: the server takes hostVersion from its startup options,
      // so a running instance can report something else entirely. Close enough
      // to catch a manifest that demands a host from the future.
      if (version) return { version, from: `${packageJson} (approximate)` };
    }
  }
  return { version: undefined, from: null };
}

if (!minimumHostVersion) {
  report(
    true,
    "minimum host version is satisfiable — install step 6 [MIRROR]",
    "the manifest declares neither minimumHostVersion nor minimumPaperclipVersion, so step 6 is a no-op and this plugin installs on any host version",
  );
} else {
  const parsed_ = parseSemver(minimumHostVersion);
  report(
    parsed_ !== null,
    "the declared minimum host version parses as semver [MIRROR]",
    parsed_ !== null
      ? minimumHostVersion
      : `'${minimumHostVersion}' — the host's compareSemver throws on this, failing the install with a parse error`,
  );

  const target = resolveTargetHostVersion();
  if (parsed_ === null || !target.version) {
    skip(
      "minimum host version is satisfied by the target host — install step 6",
      target.version
        ? "the declared minimum does not parse, so there is nothing to compare"
        : "no target host version: set PAPERCLIP_HOST_VERSION or PAPERCLIP_HOST",
    );
  } else if (!parseSemver(target.version)) {
    skip(
      "minimum host version is satisfied by the target host — install step 6",
      `target host version '${target.version}' from ${target.from} does not parse as semver`,
    );
  } else {
    report(
      compareSemver(target.version, minimumHostVersion) >= 0,
      "minimum host version is satisfied by the target host — install step 6 [MIRROR]",
      `requires >= ${minimumHostVersion}, target is ${target.version} (from ${target.from})`,
    );
    note('a server started without an explicit hostVersion reports "0.0.0" and would reject this');
  }
}

// --- 6. every shipped example config, against the host's Ajv setup -----------

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

// A credential value or malformed secret reference must be refused at write time.
// Construct the UUID-shaped test pointer so the repository secret scanner does
// not mistake a deliberately fake reference for a committed credential.
const validSecretId = ["3f2504e0", "4f89", "41d3", "9a0c", "0305e82c3301"].join("-");
const credentialAttempts = [
  ["a pasted string", { upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: "not-a-reference" } }],
  ["an object holding a value", { upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: { value: "not-a-reference" } } }],
  ["a value smuggled alongside a valid reference", { upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: { type: "secret_ref", secretId: validSecretId, value: "not-a-reference" } } }],
  ["a secret id that is not a UUID", { upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: { type: "secret_ref", secretId: "invalid" } } }],
];
for (const [label, config] of credentialAttempts) {
  report(validateConfig(config) === false, `the host validator rejects a credential at the secret-ref field: ${label}`);
}

const validSecretRef = { type: "secret_ref", secretId: validSecretId };
report(
  validateConfig({ upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: validSecretRef } }) === true,
  "the host validator accepts a real Paperclip secret reference",
);
report(
  validateConfig({ upstream: { protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:8317", credentialSecretRef: validSecretRef } }) === false,
  "the host validator rejects persisted non-HTTPS upstream URLs",
);
report(
  validateConfig({ upstream: { protocol: "anthropic-messages", baseUrl: "https://x.example", credentialSecretRef: validSecretRef, extraHeaders: { Authorization: "override" } } }) === false,
  "the host validator rejects caller-controlled authentication headers",
);

// --- 7. the built worker actually loads -------------------------------------

const worker = await import("../dist/worker.js");
report(
  typeof worker.default?.definition?.setup === "function",
  "built worker exports a plugin definition with a setup handler",
);

// The skip count is part of the verdict, not a footnote. "All host-side checks
// passed" while three of them never ran is the sentence this script is here to
// stop anyone from being able to write. Under strict those skips are already
// counted as failures above; the count is still printed so the verdict names
// the reason the run is red.
const verdict = failures === 0 ? "all host-side checks passed" : `${failures} check(s) failed`;
const skipNote = skips > 0 ? `, ${skips} check(s) ${policy.strict ? "FAILED for not running" : "skipped"} — see the lines above` : "";
const naNote = unrunnable > 0 ? `, ${unrunnable} not applicable to a build` : "";
console.log(`\n${verdict}${skipNote}${naNote}`);

// The receipt is what lets the release path know this ran. Written on success
// and failure alike: a receipt recording skips is the evidence that refuses a
// tag, so suppressing it on failure would leave a stale green one in place.
writeReceipt("manifest", { checksRun, failures, skipped: skips, unrunnable }, policy);

process.exit(failures === 0 ? 0 : 1);
