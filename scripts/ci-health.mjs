#!/usr/bin/env node
/**
 * Did CI actually RUN? — a separate question from "was CI green", and the one
 * this repository could not answer until TOG-489.
 *
 * A pull request page shows a check name and a colour. It does not show whether
 * the job behind that colour ever started. Three different states render
 * identically as a red `secret scan`:
 *
 *   1  gitleaks ran and found a credential            -> stop everything
 *   2  gitleaks ran but the scanner download failed   -> a scanner bug (TOG-488)
 *   3  no job started at all; GitHub refused the run  -> nothing was scanned
 *
 * On 2026-08-25 the third one happened: the org crossed its Actions spending
 * limit between 17:27 and 17:38, and every job in every workflow began failing
 * two seconds in, before checkout, with an annotation reading "The job was not
 * started because recent account payments have failed or your spending limit
 * needs to be increased". Four red checks that had scanned nothing, typechecked
 * nothing and built nothing, presented in exactly the shape of four checks that
 * had done all of those things and found problems.
 *
 * `docs/PROCESS.md` rule 1 and `docs/decisions/0007` both hang merge decisions
 * on "CI must be green". Neither can be applied honestly by reading check names,
 * so this script reads what is actually diagnostic and says which of the three
 * states a commit is in.
 *
 * WHAT IT READS, AND WHY THAT ENDPOINT
 *
 * `GET /repos/{repo}/commits/{sha}/check-runs`, and it asserts HTTP 200.
 *
 * The Actions API (`/actions/runs`) returns 403 for the GitHub App our agents
 * authenticate as — it has no `actions` permission and the token broker will
 * not mint one. A naive poll of that endpoint reads an empty list and concludes
 * "no runs yet", which is the most dangerous wrong answer available here: it is
 * indistinguishable from a healthy commit whose CI has not been triggered.
 * Asserting the status code is the whole defence, so an unreadable response is
 * never rounded down to an empty one.
 *
 * Annotations are fetched per check run. They are the only channel carrying
 * GitHub's own reason for refusing a job, and they are readable at `checks:read`,
 * which we do hold.
 *
 * WHY DURATION IS NOT A VERDICT
 *
 * The obvious heuristic — "it failed in 2 seconds, so it cannot have done any
 * work" — is wrong in this repository, and the evidence was already on the
 * board. The last healthy run finished its checks in 22s, 6s, 8s and 23s.
 * A six-second job is normal here, so any threshold low enough to catch a 2s
 * refusal would also fire on a passing short job. (Those timings predate
 * TOG-2547, which merged the three non-scan jobs into one; `secret scan` —
 * untouched by that merge — still passes in ~8s, so the argument stands.)
 * Duration is printed as context and classifies nothing.
 *
 * That leaves annotations as the sole definitive signal, which means a silent
 * refusal — one producing no annotation — is reported as a GENUINE failure
 * rather than an infrastructure one. That bias is deliberate. Calling
 * infrastructure "a real failure" sends someone to investigate and they find the
 * truth; calling a real failure "just the billing thing" teaches the company to
 * wave through a red build. Only one of those mistakes is self-correcting, so
 * the unproven case resolves toward the loud one. `REFUSAL_PATTERNS` is kept
 * narrow for the same reason, and `tests/ci-health.spec.ts` asserts it in both
 * directions.
 *
 * EXIT CODES — the point of this script is that these are four states, not two
 *
 *   0  GREEN        every check ran, and passed.
 *   1  RED          at least one check ran and genuinely failed. Fix the code.
 *   2  DID_NOT_RUN  at least one check was refused by infrastructure. The check
 *                   names carry no information about this commit. Escalate; do
 *                   not debug them, and do not merge on the basis of them.
 *   3  UNKNOWN      unreadable, no checks at all, a required check missing, or
 *                   still in flight. Never reported as either pass or fail.
 *
 * No code path exits 0 without having seen a completed, passing check run for
 * every check it was asked about. Zero check runs is exit 3, not exit 0 —
 * "nothing to report" is not "nothing wrong".
 *
 * Usage:
 *   node scripts/ci-health.mjs                     # HEAD, repo from git remote
 *   node scripts/ci-health.mjs --sha <sha>
 *   node scripts/ci-health.mjs --repo owner/name
 *   node scripts/ci-health.mjs --require "secret scan" --require "typecheck, test, build, package, version"
 *   node scripts/ci-health.mjs --json              # machine-readable, same exit codes
 *
 * Token: $GITHUB_TOKEN or $GH_TOKEN, otherwise `git credential fill`, which
 * picks up whatever helper the checkout is configured with. Read-only — it
 * never writes to the repository or to GitHub.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXIT = { GREEN: 0, RED: 1, DID_NOT_RUN: 2, UNKNOWN: 3 };

/**
 * Substrings of a GitHub annotation that mean "this job never started".
 *
 * Matched case-insensitively against the annotation message. Each carries the
 * label printed in the report and the audience who has to act, because the
 * failure this script exists to fix is a message reaching the wrong reader: a
 * billing problem was being shown to engineers as a secret-scanning result.
 *
 * Keep these NARROW. A pattern loose enough to match a genuine failure that
 * merely mentions "billing" — or a job that was cancelled rather than never
 * started — reintroduces the dangerous direction of the confusion, a real
 * failure dismissed as infrastructure. `tests/ci-health.spec.ts` pins both
 * directions with adversarial strings; widen a pattern only with a test.
 */
export const REFUSAL_PATTERNS = [
  {
    match: /the job was not started because/i,
    label: "GitHub refused to start the job",
    audience: "whoever holds billing for the organisation",
  },
  {
    match: /spending limit needs to be increased/i,
    label: "Actions spending limit reached",
    audience: "whoever holds billing for the organisation",
  },
  {
    match: /recent account payments have failed/i,
    label: "payment method failing",
    audience: "whoever holds billing for the organisation",
  },
  {
    match: /you have exceeded your.*(minutes|quota|usage)/i,
    label: "Actions minutes exhausted",
    audience: "whoever holds billing for the organisation",
  },
  {
    match: /no (self-hosted )?runner (is )?(online|available|matching)/i,
    label: "no runner available",
    audience: "whoever owns the runner pool",
  },
];

/** First refusal pattern matching any annotation, or null if none does. */
export function classifyRefusal(annotations) {
  for (const a of annotations ?? []) {
    const message = a?.message ?? "";
    for (const p of REFUSAL_PATTERNS) {
      if (p.match.test(message)) {
        return { label: p.label, audience: p.audience, message };
      }
    }
  }
  return null;
}

/**
 * Classify one check run. Pure: `annotations` is whatever the caller managed to
 * read, or `null` if the read itself failed — which is NOT the same as an empty
 * list, and is treated as a genuine failure per the bias documented above.
 */
export function classifyCheckRun(cr, annotations) {
  const seconds =
    cr.started_at && cr.completed_at
      ? Math.round(
          (new Date(cr.completed_at).getTime() -
            new Date(cr.started_at).getTime()) /
            1000,
        )
      : null;

  const base = {
    name: cr.name,
    status: cr.status,
    conclusion: cr.conclusion,
    seconds,
    url: cr.html_url ?? null,
  };

  if (cr.status !== "completed") return { ...base, verdict: "PENDING" };
  if (cr.conclusion === "success") return { ...base, verdict: "PASS" };
  if (cr.conclusion === "skipped" || cr.conclusion === "neutral") {
    return { ...base, verdict: "SKIPPED" };
  }

  if (annotations === null) {
    return {
      ...base,
      verdict: "FAIL",
      note: "annotations could not be read; treated as a genuine failure",
    };
  }

  const refusal = classifyRefusal(annotations);
  if (refusal) {
    return {
      ...base,
      verdict: "DID_NOT_RUN",
      reason: refusal.label,
      audience: refusal.audience,
      message: refusal.message,
    };
  }
  return { ...base, verdict: "FAIL", message: annotations[0]?.message ?? null };
}

/**
 * Fold per-check verdicts into one.
 *
 * A refusal DOMINATES a genuine failure: when the infrastructure is turning jobs
 * away, no check on the commit is evidence about the commit, including the red
 * ones. Reporting RED in that state would send someone to debug a test failure
 * that no test produced.
 *
 * `required` is the list of check names that must have PASSED — not merely
 * existed. The distinction matters and was found by an exhaustive test rather
 * than by reasoning: a commit whose `secret scan` was SKIPPED has scanned
 * nothing, but skipped checks are individually unremarkable (path filters skip
 * jobs on every healthy repository), so treating any skip as a failure would
 * cry wolf. Naming the checks you depend on is therefore the only honest way to
 * get a strong GREEN, and `docs/PROCESS.md` rule 1 names them.
 *
 * Without `required`, GREEN means "at least one check passed and nothing failed,
 * was refused, or is still running" — which tolerates a skip. That is the weaker
 * claim, and it is why the merge gate passes `--require`.
 */
export function decideVerdict(results, required = []) {
  const refused = results.filter((r) => r.verdict === "DID_NOT_RUN");
  const failed = results.filter((r) => r.verdict === "FAIL");
  const pending = results.filter((r) => r.verdict === "PENDING");
  const passed = results.filter((r) => r.verdict === "PASS");

  const byName = new Map(results.map((r) => [r.name, r]));
  const missing = required.filter((n) => !byName.has(n));
  // Present, but did not pass — a skipped required check is the case that
  // matters, since it looks like nothing at all on a PR page.
  const unsatisfied = required.filter(
    (n) => byName.has(n) && byName.get(n).verdict !== "PASS",
  );

  let verdict;
  if (results.length === 0) verdict = "UNKNOWN";
  else if (refused.length > 0) verdict = "DID_NOT_RUN";
  else if (failed.length > 0) verdict = "RED";
  else if (missing.length > 0 || unsatisfied.length > 0 || pending.length > 0) {
    verdict = "UNKNOWN";
  } else if (passed.length > 0) verdict = "GREEN";
  else verdict = "UNKNOWN";

  return { verdict, refused, failed, pending, passed, missing, unsatisfied };
}

// ---------------------------------------------------------------------------
// Everything below is I/O and presentation; the logic above is pure and tested.
// ---------------------------------------------------------------------------

function resolveToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    const line = out.split("\n").find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length) : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  const JSON_OUT = argv.includes("--json");

  const bail = (message) => {
    if (JSON_OUT) {
      console.log(
        JSON.stringify({ verdict: "UNKNOWN", error: message }, null, 2),
      );
    } else {
      console.error(`\n  UNKNOWN — ${message}\n`);
    }
    process.exit(EXIT.UNKNOWN);
  };

  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const flagAll = (name) => {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
    }
    return out;
  };
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();

  const REQUIRED = flagAll("--require");

  let sha;
  let repo;
  try {
    sha = flag("--sha") ?? git("rev-parse", "HEAD");
    repo =
      flag("--repo") ??
      (git("remote", "get-url", "origin").match(
        /github\.com[:/]+([^/]+\/[^/.]+)/,
      ) ?? [])[1];
  } catch (err) {
    bail(`cannot read git state: ${err.message}`);
  }
  if (!repo) bail("could not determine owner/repo; pass --repo owner/name");

  const token = resolveToken();
  if (!token) {
    bail(
      "no GitHub token. Set $GITHUB_TOKEN, or configure a credential helper. " +
        "Refusing to guess a verdict without being able to read the checks.",
    );
  }

  const gh = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "paperclip-model-router-ci-health",
      },
    });
    // The assertion this script exists to make: a 403 is not an empty list.
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GET ${path} -> HTTP ${res.status}. This is NOT the same as "no checks ` +
          `have run"; it means the checks could not be read at all. ` +
          `${body.slice(0, 200)}`,
      );
    }
    return res.json();
  };

  let checkRuns;
  try {
    const data = await gh(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    );
    checkRuns = data.check_runs ?? [];
  } catch (err) {
    bail(err.message);
  }

  // A commit with no checks is not a passing commit. It is a commit nothing has
  // vouched for, which is the state this script refuses to round down to 0.
  if (checkRuns.length === 0) {
    bail(
      `no check runs exist for ${sha.slice(0, 7)} on ${repo}. Either no ` +
        `workflow was triggered, or the run was refused before any check was ` +
        `created. Nothing has verified this commit.`,
    );
  }

  const results = [];
  for (const cr of checkRuns) {
    let annotations = [];
    const needsAnnotations =
      cr.status === "completed" &&
      cr.conclusion !== "success" &&
      cr.conclusion !== "skipped" &&
      cr.conclusion !== "neutral";
    if (needsAnnotations) {
      try {
        annotations = await gh(
          `/repos/${repo}/check-runs/${cr.id}/annotations?per_page=100`,
        );
      } catch {
        annotations = null;
      }
    }
    results.push(classifyCheckRun(cr, annotations));
  }

  const { verdict, refused, failed, pending, passed, missing, unsatisfied } =
    decideVerdict(results, REQUIRED);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { repo, sha, verdict, checks: results, missing, unsatisfied },
        null,
        2,
      ),
    );
  } else {
    const MARK = {
      PASS: "ok  ",
      FAIL: "FAIL",
      DID_NOT_RUN: "DEAD",
      PENDING: "... ",
      SKIPPED: "skip",
    };
    console.log(`\n  ${repo} @ ${sha.slice(0, 7)}`);
    console.log("  " + "-".repeat(70));
    for (const r of results) {
      const dur = r.seconds === null ? "" : ` ${r.seconds}s`;
      console.log(`  ${MARK[r.verdict] ?? "?   "}  ${r.name}${dur}`);
      if (r.reason) {
        console.log(`        ${r.reason} — for ${r.audience}`);
        console.log(`        GitHub said: "${r.message}"`);
      } else if (r.verdict === "FAIL" && r.message) {
        console.log(`        ${r.message.split("\n")[0].slice(0, 90)}`);
      }
      if (r.note) console.log(`        ${r.note}`);
    }
    for (const want of missing) {
      console.log(`  ?     ${want} — required, but no such check exists`);
    }

    console.log("  " + "-".repeat(70));
    if (verdict === "GREEN") {
      console.log(`  GREEN — ${passed.length} check(s) ran and passed.`);
    } else if (verdict === "RED") {
      console.log(`  RED — ${failed.length} check(s) ran and failed.`);
      console.log("  This is a real result: the jobs did their work and did not");
      console.log("  like what they found. Read them.");
    } else if (verdict === "DID_NOT_RUN") {
      console.log(`  CI DID NOT RUN — ${refused.length} job(s) were refused.`);
      console.log("");
      console.log("  The red checks on this commit verified NOTHING. Nothing was");
      console.log("  typechecked, built, or scanned for secrets. Do not read the");
      console.log("  check names as findings and do not debug them — the cause is");
      console.log(`  ${refused[0].reason}, which is not a code problem.`);
      console.log("");
      console.log(`  This needs ${refused[0].audience}, not an engineer.`);
    } else {
      console.log("  UNKNOWN — cannot vouch for this commit.");
      if (pending.length) {
        console.log(`  ${pending.length} check(s) still running.`);
      }
      for (const want of missing) {
        console.log(`  required check "${want}" did not appear at all.`);
      }
      for (const want of unsatisfied) {
        const r = results.find((x) => x.name === want);
        console.log(
          `  required check "${want}" exists but did not pass (${r.verdict}); ` +
            `it verified nothing.`,
        );
      }
    }
    console.log("");
  }

  process.exit(EXIT[verdict]);
}

// Run only when invoked directly, so `tests/ci-health.spec.ts` can import the
// pure classifiers above without the CLI firing and calling process.exit.
const invokedDirectly =
  process.argv[1] &&
  (() => {
    try {
      return (
        realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
      );
    } catch {
      return false;
    }
  })();

if (invokedDirectly) await main(process.argv.slice(2));
