#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hostRoot = process.env.PAPERCLIP_HOST ?? "/app";

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
    console.log(`SKIP  stock host control probes\n      no tsx loader found under ${join(hostRoot, "node_modules", ".pnpm")}`);
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

function report(ok, label, detail = "") {
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

console.log(`\n${failures === 0 ? "STOCK HOST CONTROL PROBES PASSED" : `${failures} stock host control probe(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
