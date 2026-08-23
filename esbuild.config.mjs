// Builds the two runtime entrypoints the host loads: dist/manifest.js and
// dist/worker.js. Paths must match the `paperclipPlugin` block in package.json —
// the host watcher targets exactly those files.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/manifest.ts", "src/worker.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  // The SDK is resolved from the plugin's own node_modules at runtime; bundling
  // it would pin a private copy and break host/worker protocol compatibility.
  external: ["@paperclipai/plugin-sdk", "@paperclipai/shared"],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching src/ — dist/ rebuilds on save");
} else {
  await build(options);
}
