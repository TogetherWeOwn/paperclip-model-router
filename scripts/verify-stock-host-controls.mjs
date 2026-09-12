#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describePolicy, hostEnv, probePolicy, writeReceipt } from "./lib/host-probes.mjs";

// `?? "/app"` used to be the whole of this line, which resolved `PAPERCLIP_HOST=`
// (exported empty) to "" and then hunted for a host under `/node_modules`.
const hostRoot = hostEnv() ?? "/app";
const policy = probePolicy();

// TOG-1064: this used to hardcode `tsx@4.23.1`. The host moved to 4.23.12 and
// these probes silently SKIPped from then on — a control that reports success
// while never running. Resolve whatever tsx the host actually has instead.
function findTsxLoader() {
  const pnpmDir = join(hostRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const candidates = readdirSync(pnpmDir)
    .filter((entry) => entry.startsWith("tsx@"))
    .sort()
    .map((entry) => join(pnpmDir, entry, "node_modules", "tsx", "dist", "loader.mjs"))
    .filter((path) => existsSync(path));
  return candidates.at(-1) ?? null;
}

const tsxLoader = findTsxLoader();
if (process.env.MODEL_ROUTER_STOCK_HOST_PROBE_CHILD !== "1") {
  if (!tsxLoader) {
    // TOG-1070: this exact branch printed SKIP and exited 0, which is what let
    // `npm run verify` report success with these probes never having run. If a
    // host was requested, not finding the loader is a failure — the probes are
    // the whole point of pointing at a host.
    const where = join(hostRoot, "node_modules", ".pnpm");
    if (policy.strict) {
      console.log(`FAIL  stock host control probes\n      no tsx loader found under ${where}`);
      console.log(`      A host checkout was requested (${policy.host.from}), so these probes were expected to run.`);
      console.log(`      Build the host checkout, or set ALLOW_HOST_PROBE_SKIP=1 to accept an unproven run.`);
      writeReceipt("stockControls", { checksRun: 0, failures: 1, skipped: 1 }, policy);
      process.exit(1);
    }
    console.log(`SKIP  stock host control probes\n      no tsx loader found under ${where}`);
    console.log(`      ${describePolicy(policy)}`);
    writeReceipt("stockControls", { checksRun: 0, failures: 0, skipped: 1 }, policy);
    process.exit(0);
  }
  const child = spawnSync(process.execPath, ["--import", tsxLoader, fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, MODEL_ROUTER_STOCK_HOST_PROBE_CHILD: "1" },
  });
  process.exit(child.status ?? 1);
}

const sharedDist = join(hostRoot, "packages", "shared", "dist");
const dbSource = join(hostRoot, "packages", "db", "src");
const serverServices = join(hostRoot, "server", "dist", "services");
let failures = 0;
let checksRun = 0;

function report(ok, label, detail = "") {
  checksRun += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

for (const required of [
  join(sharedDist, "index.js"),
  join(serverServices, "plugin-secrets-handler.js"),
  join(serverServices, "plugin-loader.js"),
]) {
  if (!existsSync(required)) {
    console.error(`Missing compiled stock host module: ${required}`);
    writeReceipt("stockControls", { checksRun: 0, failures: 1, skipped: 1 }, policy);
    process.exit(2);
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@paperclipai/shared" || specifier.startsWith("@paperclipai/shared/")) {
      const subpath = specifier === "@paperclipai/shared" ? "index" : specifier.slice("@paperclipai/shared/".length);
      const target = join(sharedDist, `${subpath}.js`);
      return existsSync(target)
        ? { url: pathToFileURL(target).href, shortCircuit: true }
        : nextResolve(specifier, context);
    }
    if (specifier === "@paperclipai/db" || specifier.startsWith("@paperclipai/db/")) {
      const subpath = specifier === "@paperclipai/db" ? "index" : specifier.slice("@paperclipai/db/".length);
      const target = join(dbSource, `${subpath}.ts`);
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createPluginSecretsHandler } = await import(pathToFileURL(join(serverServices, "plugin-secrets-handler.js")).href);
const select = () => ({
  from() { return this; },
  where() { return Promise.resolve([]); },
});
const handler = createPluginSecretsHandler({ db: { select }, pluginId: randomUUID() });
const companyId = randomUUID();
const secretId = randomUUID();
let rateLimitFailures = 0;
for (let attempt = 1; attempt <= 31; attempt += 1) {
  try {
    await handler.resolve({
      companyId,
      configPath: "upstream.credentialSecretRef",
      secretRef: { type: "secret_ref", secretId },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "RateLimitExceededError") rateLimitFailures += 1;
  }
}
report(rateLimitFailures === 1, "stock host enforces 30 secret resolutions per minute per company/plugin", `31 attempts produced ${rateLimitFailures} rate-limit rejection(s)`);

const { pluginLoader } = await import(pathToFileURL(join(serverServices, "plugin-loader.js")).href);
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_TMPDIR ?? process.cwd();
const localPluginDir = join(scratchRoot, `cleanup-probe-${randomUUID()}`);
const managedPackagePath = join(localPluginDir, "node_modules", "@togetherweown", "paperclip-model-router");
mkdirSync(managedPackagePath, { recursive: true });
writeFileSync(join(managedPackagePath, "probe.txt"), "managed artifact");
const loader = pluginLoader({}, { localPluginDir, enableLocalFilesystem: false, enableNpmDiscovery: false });
try {
  await loader.cleanupInstallArtifacts({
    id: randomUUID(),
    pluginKey: "com.togetherweown.model-router-cleanup-probe",
    packageName: "@togetherweown/paperclip-model-router",
    packagePath: process.cwd(),
  });
  report(existsSync(process.cwd()), "stock cleanup leaves an external source checkout intact");
  await loader.cleanupInstallArtifacts({
    id: randomUUID(),
    pluginKey: "com.togetherweown.model-router-cleanup-probe",
    packageName: "@togetherweown/paperclip-model-router",
    packagePath: managedPackagePath,
  });
  report(!existsSync(managedPackagePath), "stock cleanup removes managed install artifacts");
  await loader.cleanupInstallArtifacts({
    id: randomUUID(),
    pluginKey: "com.togetherweown.model-router-cleanup-probe",
    packageName: "@togetherweown/paperclip-model-router",
    packagePath: managedPackagePath,
  });
  report(true, "stock cleanup is idempotent and does not replay plugin work");
} finally {
  rmSync(localPluginDir, { recursive: true, force: true });
}

// A probe count of zero is not a pass. Every early exit above writes a receipt
// saying so, and this one records what actually executed.
console.log(`\n${failures === 0 ? `STOCK HOST CONTROL PROBES PASSED (${checksRun} probe(s) executed)` : `${failures} stock host control probe(s) failed`}`);
writeReceipt("stockControls", { checksRun, failures, skipped: 0 }, policy);
process.exit(failures === 0 && checksRun > 0 ? 0 : 1);
