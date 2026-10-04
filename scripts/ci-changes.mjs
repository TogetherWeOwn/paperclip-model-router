#!/usr/bin/env node
/**
 * Change detection for CI: decide whether the heavy `verify` job has to run.
 *
 * CI runs only what a change affects (decision record 0013). This repo has one
 * heavy job, so it has one area: `code`. It is `false` ONLY when every changed
 * file is documentation that no test, script, build step or package manifest
 * reads. Everything else — source, tests, scripts, migrations, packages, the
 * dependency manifest and lockfile, build and TypeScript config, `.github/**`
 * (the workflows and this filter's own caller), and this file — runs the full
 * job.
 *
 * The allow-list below is deliberately short and fails safe: a path that is not
 * on it means "run everything". A path moves ONTO the list only when nothing in
 * `tests/`, `scripts/`, `package.json` `files` or the pack step reads it. These
 * are read by tests today and so are NOT listed: `README.md`, `CHANGELOG.md`,
 * `docs/OPERATIONS.md`, `docs/PROCESS.md`, `docs/contracts/**`, `docs/operator/**`,
 * `docs/branch-ruleset.main.json`.
 *
 * Fail-safe, not fail-open: a non-PR event (push to main, nightly schedule,
 * manual dispatch), an unresolvable merge base, an empty diff or any error all
 * answer `code=true`. The only route to `false` is a successful diff whose
 * every path is allow-listed.
 *
 * Env (set by the workflow): EVENT_NAME, BASE_SHA, HEAD_SHA, GITHUB_OUTPUT.
 * Without GITHUB_OUTPUT the result is printed to stdout, so it can be run by
 * hand: `EVENT_NAME=pull_request BASE_SHA=origin/main HEAD_SHA=HEAD node scripts/ci-changes.mjs`.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Documentation nothing executes or reads. See the header before editing. */
export const DOCS_ONLY = [
  /^CONTRIBUTING\.md$/,
  /^AGENTS\.md$/,
  /^docs\/decisions\//,
  /^docs\/security\//,
];

/**
 * @param {readonly string[]} files changed paths, repo-relative
 * @returns {{ code: boolean, reason: string }}
 */
export function classify(files) {
  const paths = files.map((f) => f.trim()).filter(Boolean);
  if (paths.length === 0) {
    return { code: true, reason: "empty diff: run everything" };
  }
  // `git diff --name-only` never emits a `..` segment; one means the input is not
  // what we think it is, so it is never "docs".
  const isDocs = (p) => !p.split("/").includes("..") && DOCS_ONLY.some((re) => re.test(p));
  const code = paths.filter((p) => !isDocs(p));
  if (code.length > 0) {
    return { code: true, reason: `${code.length} non-docs path(s), e.g. ${code[0]}` };
  }
  return { code: false, reason: `docs only (${paths.length} path(s))` };
}

/**
 * @param {{ EVENT_NAME?: string, BASE_SHA?: string, HEAD_SHA?: string }} env
 * @param {(args: string[]) => string} git
 */
export function detect(env, git) {
  if (env.EVENT_NAME !== "pull_request") {
    return { code: true, reason: `${env.EVENT_NAME || "unknown"} event: full run` };
  }
  if (!env.BASE_SHA || !env.HEAD_SHA) {
    return { code: true, reason: "missing base or head sha: full run" };
  }
  try {
    const base = git(["merge-base", env.BASE_SHA, env.HEAD_SHA]).trim();
    const files = git(["diff", "--name-only", base, env.HEAD_SHA]).split("\n");
    return { ...classify(files), files: files.filter(Boolean) };
  } catch (err) {
    return { code: true, reason: `diff failed (${err instanceof Error ? err.message : err}): full run` };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8" });
  const result = detect(process.env, git);
  for (const f of result.files ?? []) console.log(`changed: ${f}`);
  console.log(`code=${result.code} (${result.reason})`);
  const line = `code=${result.code}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
}
