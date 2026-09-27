// TOG-5466: run the pinned corpus against ONE bundle dir, print JSON rows.
// Executed twice by compare.mjs (baseline dir, candidate dir) via the tsx
// CLI, so both bundles execute byte-identical eval logic from THIS file.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCorpus, loadFixtureRaw, runCase, type BundleFns } from "./eval-lib.js";

const bundleDir = resolve(process.argv[2]!);
const url = (p: string) => pathToFileURL(p).href;
const resolveMod = await import(url(join(bundleDir, "src", "config", "resolve.ts")));
const validateMod = await import(url(join(bundleDir, "src", "inference", "validate.ts")));
const selectMod = await import(url(join(bundleDir, "src", "engine", "select.ts")));
const bundle: BundleFns = {
  resolveConfig: resolveMod.resolveConfig,
  parseInvokeRequest: validateMod.parseInvokeRequest,
  selectModel: selectMod.selectModel,
};
const fixture = loadFixtureRaw(bundleDir);
const rows = loadCorpus().map((c) => runCase(bundle, fixture, c));
console.log(JSON.stringify(rows));
