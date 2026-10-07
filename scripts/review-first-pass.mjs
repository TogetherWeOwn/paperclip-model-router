#!/usr/bin/env node
/**
 * How often does a pull request pass its review the first time?
 *
 * The "Paperclip Review" check passes only at 5/5, so a 4/5 ("minor concerns
 * remain") costs the author another push, another CI run and another review.
 * This script measures that cost from the one place it is recorded for every
 * repository: the review check runs on each commit of each merged PR.
 *
 * DEFINITIONS (they decide what the number means, so they are fixed here)
 *
 *   review       one completed "Paperclip Review" check run. One head normally
 *                has one; the check is updated in place when the same head is
 *                reassessed, so a same-head reassessment is NOT counted twice.
 *   scored       a review whose title or summary carries `N/5`.
 *   not scored   a completed check with no score: "Authorized manual review
 *                required" (the bot was not authorised to review that author's
 *                PR), "Incomplete review", "Review execution did not complete",
 *                "Agent finished without a complete assessment". None of them
 *                says anything about the code, so they stay out of the
 *                pass-rate denominator and are reported on their own line.
 *                Counting them would make an identity or configuration gap
 *                look like an author quality problem.
 *   first pass   the first SCORED review of the PR is 5/5.
 *   rounds       scored reviews per PR (1 means it passed or failed once and
 *                the PR merged without a second scored review).
 *
 * The alternative reading (first COMPLETED review, scored or not, is 5/5) is
 * printed beside it as `naive`, so the two can be compared with any figure
 * produced by another method.
 *
 * Read-only. It shells out to `gh api`, so it uses whatever GitHub access the
 * calling session already has and never reads, prints or exports a token.
 *
 * Usage:
 *   node scripts/review-first-pass.mjs --repo owner/name [--repo owner/name ...]
 *   node scripts/review-first-pass.mjs --repo owner/name --limit 100 --json
 *   node scripts/review-first-pass.mjs --repo owner/name --since 2026-10-05
 *   node scripts/review-first-pass.mjs --from-file records.json   # offline
 *
 * `--limit` is the number of merged PRs to read per repository, most recently
 * updated first. `--since` keeps only PRs created on or after that date (ISO
 * date), which is how to compare periods: run it once per window.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
/** Parallel `gh api` calls per repository. Enough to be quick, few enough not to trip secondary rate limits. */
const CONCURRENCY = 6;

export const CHECK_NAME = "Paperclip Review";

/**
 * The score of a completed review: the check's title is exactly `N/5`, or failing
 * that the summary's heading reads `## Paperclip Review — N/5`. Prose elsewhere in
 * a summary ("4/5 suites pass", "re-reviewed at 3/5") is never a score, and a
 * heading reading `Incomplete` is none either. null when there is no score.
 */
export function parseScore(checkRun) {
  const out = checkRun?.output ?? {};
  const fromTitle = typeof out.title === "string" ? /^\s*([0-5])\s*\/\s*5\s*$/.exec(out.title) : null;
  if (fromTitle) return Number(fromTitle[1]);
  const fromHeading =
    typeof out.summary === "string" ? /^\s*#*\s*Paperclip Review\s*[\u2014\u2013-]\s*([0-5])\s*\/\s*5\b/m.exec(out.summary) : null;
  return fromHeading ? Number(fromHeading[1]) : null;
}

/**
 * Classify one check run. `scored` carries the score; `manual_required` and
 * `incomplete` are not about the code; `pending` has not finished.
 */
export function classifyReview(checkRun) {
  if (checkRun?.status !== "completed") return { kind: "pending", score: null };
  const score = parseScore(checkRun);
  if (score !== null) return { kind: "scored", score };
  const text = `${checkRun?.output?.title ?? ""}\n${checkRun?.output?.summary ?? ""}`;
  if (/authorized manual review required/i.test(text)) {
    return { kind: "manual_required", score: null };
  }
  return { kind: "incomplete", score: null };
}

/**
 * One PR record in, one verdict out. `reviews` are that PR's review check runs
 * in any order; they are ordered by start time here so the caller cannot get
 * the "first" review wrong by passing them newest first.
 */
export function summarizePr(record) {
  const ordered = [...(record.reviews ?? [])].sort((a, b) =>
    String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")),
  );
  const classified = ordered.map((r) => ({ ...classifyReview(r), run: r }));
  const completed = classified.filter((c) => c.kind !== "pending");
  const scored = completed.filter((c) => c.kind === "scored");
  return {
    repo: record.repo,
    number: record.number,
    author: record.author ?? null,
    commits: record.commits ?? null,
    completed: completed.length,
    scored: scored.length,
    notScored: completed.length - scored.length,
    firstScore: scored.length ? scored[0].score : null,
    firstCompletedKind: completed.length ? completed[0].kind : null,
    firstCompletedScore: completed.length ? completed[0].score : null,
    firstPass: scored.length ? scored[0].score === 5 : null,
  };
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const mean = (xs) => (xs.length ? Math.round((100 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 100 : null);

/** Aggregate PR verdicts. Pure. */
export function summarize(records) {
  const prs = records.map(summarizePr);
  const reviewed = prs.filter((p) => p.completed > 0);
  const scoredPrs = prs.filter((p) => p.scored > 0);
  const firstPass = scoredPrs.filter((p) => p.firstPass).length;
  const naive = reviewed.filter((p) => p.firstCompletedScore === 5).length;
  const dist = {};
  for (const p of scoredPrs) dist[p.firstScore] = (dist[p.firstScore] ?? 0) + 1;
  const byRepo = {};
  for (const p of reviewed) {
    const r = (byRepo[p.repo ?? "unknown"] ??= { prs: 0, scoredPrs: 0, firstPass: 0, scoredRounds: 0 });
    r.prs += 1;
    if (p.scored > 0) {
      r.scoredPrs += 1;
      r.scoredRounds += p.scored;
      if (p.firstPass) r.firstPass += 1;
    }
  }
  const byAuthor = {};
  for (const p of reviewed) {
    const a = (byAuthor[p.author ?? "unknown"] ??= { prs: 0, scoredPrs: 0, firstPass: 0, notScoredRuns: 0 });
    a.prs += 1;
    a.notScoredRuns += p.notScored;
    if (p.scored > 0) {
      a.scoredPrs += 1;
      if (p.firstPass) a.firstPass += 1;
    }
  }
  return {
    mergedPrs: prs.length,
    prsWithReview: reviewed.length,
    prsWithScoredReview: scoredPrs.length,
    firstPass,
    firstPassRatePct: pct(firstPass, scoredPrs.length),
    naiveFirstPass: naive,
    naiveFirstPassRatePct: pct(naive, reviewed.length),
    firstScoreDistribution: dist,
    scoredRoundsPerPr: mean(scoredPrs.map((p) => p.scored)),
    completedChecksPerPr: mean(reviewed.map((p) => p.completed)),
    notScoredChecks: reviewed.reduce((n, p) => n + p.notScored, 0),
    totalChecks: reviewed.reduce((n, p) => n + p.completed, 0),
    byRepo,
    byAuthor,
  };
}

async function gh(path) {
  const { stdout } = await execFileAsync("gh", ["api", path], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Every item of a list endpoint. `pick` returns the page's array from its body. */
async function ghAll(path, pick = (body) => body) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = pick(await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/** Run `fn` over `items`, at most `limit` at a time, keeping input order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Merged PRs most recently updated first, up to `limit`. */
async function mergedPrs(repo, limit, since) {
  const prs = [];
  for (let page = 1; prs.length < limit; page++) {
    const batch = await gh(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!batch.length) break;
    for (const p of batch) {
      if (!p.merged_at) continue;
      if (since && p.created_at < since) continue;
      prs.push(p);
    }
    if (batch.length < 100) break;
  }
  return prs.slice(0, limit);
}

/** Collect one repository's PR records from GitHub. */
export async function collect(repo, { limit = 50, since = null } = {}) {
  const prs = await mergedPrs(repo, limit, since);
  return pool(prs, CONCURRENCY, async (pr) => {
    const commits = await ghAll(`repos/${repo}/pulls/${pr.number}/commits`);
    const perCommit = await pool(commits, CONCURRENCY, (c) =>
      ghAll(`repos/${repo}/commits/${c.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}`, (b) => b.check_runs ?? []),
    );
    const reviews = perCommit.flat().filter((cr) => cr.name === CHECK_NAME);
    return { repo, number: pr.number, author: pr.user?.login ?? null, commits: commits.length, reviews };
  });
}

function parseArgs(argv) {
  const args = { repos: [], limit: 50, since: null, json: false, fromFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repos.push(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--from-file") args.fromFile = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.fromFile && !args.repos.length) throw new Error("give --repo owner/name or --from-file");
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit must be a positive integer");
  return args;
}

export function render(s) {
  const lines = [
    `merged PRs read:             ${s.mergedPrs}`,
    `with a completed review:     ${s.prsWithReview}`,
    `with a scored review:        ${s.prsWithScoredReview}`,
    `first pass (5/5 first):      ${s.firstPass} / ${s.prsWithScoredReview} = ${s.firstPassRatePct ?? "n/a"}%`,
    `naive first completed 5/5:   ${s.naiveFirstPass} / ${s.prsWithReview} = ${s.naiveFirstPassRatePct ?? "n/a"}%`,
    `first scored review:         ${JSON.stringify(s.firstScoreDistribution)}`,
    `scored rounds per PR:        ${s.scoredRoundsPerPr ?? "n/a"}`,
    `completed checks per PR:     ${s.completedChecksPerPr ?? "n/a"}`,
    `not scored (no verdict):     ${s.notScoredChecks} of ${s.totalChecks} checks`,
    "by repository:",
  ];
  for (const [repo, r] of Object.entries(s.byRepo).sort()) {
    lines.push(
      `  ${repo.padEnd(40)} PRs ${String(r.prs).padStart(3)}  scored ${String(r.scoredPrs).padStart(3)}  first pass ${String(r.firstPass).padStart(3)} (${pct(r.firstPass, r.scoredPrs) ?? "n/a"}%)  rounds/PR ${r.scoredPrs ? Math.round((100 * r.scoredRounds) / r.scoredPrs) / 100 : "n/a"}`,
    );
  }
  lines.push("by PR author:");
  for (const [author, a] of Object.entries(s.byAuthor).sort()) {
    lines.push(
      `  ${author.padEnd(24)} PRs ${String(a.prs).padStart(3)}  scored ${String(a.scoredPrs).padStart(3)}  first pass ${String(a.firstPass).padStart(3)}  not-scored checks ${a.notScoredRuns}`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = args.fromFile
    ? JSON.parse(readFileSync(args.fromFile, "utf8"))
    : (await Promise.all(args.repos.map((repo) => collect(repo, { limit: args.limit, since: args.since })))).flat();
  const summary = summarize(records);
  console.log(args.json ? JSON.stringify(summary, null, 2) : render(summary));
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    await main();
  } catch (err) {
    console.error(`review-first-pass: ${err.message}`);
    process.exit(2);
  }
}
