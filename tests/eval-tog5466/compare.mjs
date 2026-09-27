// TOG-5466: baseline-vs-candidate compare runner.
//
// Executes the pinned corpus against BOTH bundles with byte-identical eval
// logic (eval-lib.ts + run-one.ts, executed per-bundle via the tsx CLI — no
// build step needed in either tree):
//   node tests/eval-tog5466/compare.mjs <baseline-dir> <candidate-dir>
//
// Prints a markdown eval table to stdout. Exits 0 when the ONLY diffs are the
// intended TOG-5247 rows (P22-P26: baseline ok -> candidate invalid-request),
// nonzero otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [baselineDir, candidateDir] = process.argv.slice(2).map((p) => resolve(p));
if (!baselineDir || !candidateDir) {
  console.error("usage: compare.mjs <baseline-dir> <candidate-dir>");
  process.exit(2);
}

function runBundle(dir) {
  const tsxBin = join(candidateDir, "node_modules", ".bin", "tsx");
  const out = execFileSync(tsxBin, [join(here, "run-one.ts"), dir], {
    cwd: candidateDir,
    env: { ...process.env, NODE_ENV: "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(String(out));
}

const baseRows = runBundle(baselineDir);
const candRows = runBundle(candidateDir);
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const base = byId(baseRows);
const cand = byId(candRows);
if (baseRows.length !== candRows.length) {
  console.error(`row count mismatch: baseline ${baseRows.length}, candidate ${candRows.length}`);
  process.exit(1);
}

const baseFixture = JSON.parse(readFileSync(join(baselineDir, "tests", "fixtures", "company-a.json"), "utf8"));
const candFixture = JSON.parse(readFileSync(join(candidateDir, "tests", "fixtures", "company-a.json"), "utf8"));
const fixturesIdentical = JSON.stringify(baseFixture) === JSON.stringify(candFixture);

const INTENDED = new Set(["P22-name-65-def", "P23-name-90-def-gateway", "P24-name-65-toolchoice-object", "P25-name-90-toolcall-block", "P26-name-65-second-of-two"]);

const fmt = (r) => r.parse === "ok"
  ? `${r.outcome} / ${r.modelId ?? "—"}`
  : `${r.parse}: ${r.parseMessage}`;

const lines = [];
lines.push("| id | baseline (v0.7.0) | candidate (HEAD) | verdict |");
lines.push("| --- | --- | --- | --- |");
let regressions = 0;
let intended = 0;
for (const b of baseRows) {
  const d = cand.get(b.id);
  if (!d) { lines.push(`| ${b.id} | ${fmt(b)} | MISSING | **REGRESSION** |`); regressions++; continue; }
  let verdict;
  if (fmt(b) === fmt(d)) verdict = "same";
  else if (INTENDED.has(b.id) && b.parse === "ok" && d.parse === "invalid-request" && d.outcome === null) {
    verdict = "INTENDED (TOG-5247)"; intended++;
  } else { verdict = "**REGRESSION**"; regressions++; }
  lines.push(`| ${b.id} | ${fmt(b)} | ${fmt(d)} | ${verdict} |`);
}
console.log(`fixtures identical: ${fixturesIdentical}`);
console.log(`rows: ${baseRows.length}, same: ${baseRows.length - regressions - intended}, intended: ${intended}, regressions: ${regressions}`);
console.log("");
console.log(lines.join("\n"));
process.exit(fixturesIdentical && regressions === 0 ? 0 : 1);
