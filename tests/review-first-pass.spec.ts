/**
 * Guard suite for scripts/review-first-pass.mjs.
 *
 * The script turns review check runs into a first-pass rate. The number is only
 * useful if its definitions hold, so the tests pin the definitions, one at a
 * time, with the check titles the review bot really publishes:
 *
 *   - a review is scored only by an exact `N/5` title or a `Paperclip Review — N/5`
 *     heading; prose that merely contains `4/5` is not a score,
 *   - "Authorized manual review required" and the incomplete variants carry no
 *     verdict about the code, so they stay out of the pass-rate denominator,
 *   - "first" means earliest by start time, whatever order the caller lists runs,
 *   - a review still in progress is not a review yet.
 *
 * Offline: no GitHub access; pure functions, the argument parser and an injected
 * collector transport (shared-head attribution and pagination).
 */

import { describe, expect, it } from "vitest";

// scripts/ is outside tsconfig's `include` and has no declarations, so resolve
// the module through a computed specifier (same approach as ci-health.spec.ts).
type Run = {
  status: string;
  started_at?: string;
  name?: string;
  external_id?: string | null;
  head_sha?: string;
  output?: { title?: string; summary?: string };
};
type PrRecord = { repo?: string; number: number; author?: string | null; commits?: number; reviews: Run[] };
type Summary = {
  mergedPrs: number;
  prsWithReview: number;
  prsWithScoredReview: number;
  firstPass: number;
  firstPassRatePct: number | null;
  naiveFirstPass: number;
  naiveFirstPassRatePct: number | null;
  firstScoreDistribution: Record<string, number>;
  scoredRoundsPerPr: number | null;
  completedChecksPerPr: number | null;
  notScoredChecks: number;
  totalChecks: number;
  byRepo: Record<string, { prs: number; scoredPrs: number; firstPass: number; scoredRounds: number }>;
  byAuthor: Record<string, { prs: number; scoredPrs: number; firstPass: number; notScoredRuns: number }>;
};
type Mod = {
  checkRunsPath: (repo: string, sha: string) => string;
  reviewPrNumber: (cr: Run) => number;
  collect: (repo: string, options: { request: (path: string) => Promise<unknown> }) => Promise<PrRecord[]>;
  parseScore: (cr: Run) => number | null;
  classifyReview: (cr: Run) => { kind: string; score: number | null };
  summarizePr: (r: PrRecord) => {
    firstScore: number | null;
    firstPass: boolean | null;
    scored: number;
    notScored: number;
    firstCompletedKind: string | null;
    firstCompletedScore: number | null;
  };
  summarize: (rs: PrRecord[]) => Summary;
  render: (s: Summary) => string;
  parseArgs: (argv: string[]) => { repos: string[]; limit: number; since: string | null; json: boolean; fromFile: string | null };
};
const spec = "../scripts/review-first-pass.mjs";
const mod = (await import(/* @vite-ignore */ spec)) as Mod;
const { checkRunsPath, reviewPrNumber, collect, parseScore, classifyReview, summarizePr, summarize, render, parseArgs } = mod;

const scored = (n: number, at: string): Run => ({
  status: "completed",
  started_at: at,
  output: { title: `${n}/5`, summary: `## Paperclip Review — ${n}/5\n\nbody` },
});
const manual = (at: string): Run => ({
  status: "completed",
  started_at: at,
  output: {
    title: "Authorized manual review required",
    summary: "Authorized manual review required. An authorized person can mention the bot to request a review of this head.",
  },
});
const incomplete = (at: string): Run => ({
  status: "completed",
  started_at: at,
  output: { title: "Incomplete review", summary: "## Paperclip Review — Incomplete\n\nCoverage was not established." },
});
const running = (at: string): Run => ({
  status: "in_progress",
  started_at: at,
  output: { title: "Agent is reviewing this commit", summary: "Agent is reviewing this commit." },
});

describe("checkRunsPath", () => {
  it("fetches every run per head, not just the newest", () => {
    // GitHub defaults to filter=latest (one run per check name), which hides an
    // earlier review when the same head is re-reviewed. A re-review posts a new
    // run, so without filter=all a 4/5 followed by a 5/5 on one head reads as
    // a first pass.
    const path = checkRunsPath("o/a", "abc123");
    expect(path).toContain("filter=all");
    expect(path).toContain("check_name=Paperclip%20Review");
  });
});

const head = "a".repeat(40);
const attributed = (pr: number, score: number, at: string): Run => ({
  ...scored(score, at),
  name: "Paperclip Review",
  head_sha: head,
  external_id: `00000000-0000-4000-8000-000000000000:${pr}:${head}`,
});

describe("reviewPrNumber", () => {
  it("uses Paperclip's PR identity, not the commit shared by stacked PRs", () => {
    expect(reviewPrNumber(attributed(1, 4, "t1"))).toBe(1);
    expect(reviewPrNumber(attributed(2, 5, "t2"))).toBe(2);
  });

  it("refuses absent, malformed, and unsafe PR identities rather than guessing", () => {
    for (const external_id of [null, "", "other-format", `not-a-uuid:2:${head}`, `00000000-0000-4000-8000-000000000000:0:${head}`, `00000000-0000-4000-8000-000000000000:9007199254740992:${head}`]) {
      expect(() => reviewPrNumber({ ...attributed(2, 5, "t1"), external_id })).toThrow(/attribute/i);
    }
  });

  it("requires the identity's head to match the check's head", () => {
    expect(() => reviewPrNumber({ ...attributed(2, 5, "t1"), head_sha: "b".repeat(40) })).toThrow(/attribute/i);
    expect(() => reviewPrNumber({ ...attributed(2, 5, "t1"), head_sha: undefined })).toThrow(/attribute/i);
  });
});

describe("collect", () => {
  const prs = [1, 2].map((number) => ({ number, merged_at: "2026-10-07T01:00:00Z", user: { login: "dev" } }));
  const runs = [attributed(1, 4, "t1"), attributed(1, 5, "t2"), attributed(2, 5, "t3")];
  const request = async (path: string): Promise<unknown> => {
    if (path.includes("/pulls?")) return prs;
    if (path.includes("/commits?")) return [{ sha: head }];
    if (path.includes("/check-runs?")) {
      expect(path).toContain("filter=all");
      return { check_runs: runs };
    }
    throw new Error(`Unexpected test path: ${path}`);
  };

  it("does not credit an earlier PR's reviews to another PR sharing the head", async () => {
    const records = await collect("o/a", { request });
    expect(records.map((r) => summarizePr(r))).toMatchObject([
      { firstPass: false, scored: 2 },
      { firstPass: true, scored: 1 },
    ]);
  });

  it("ignores unrelated check names before requiring Paperclip attribution", async () => {
    const otherCheck = async (path: string) => path.includes("/check-runs?")
      ? { check_runs: [...runs, { status: "completed", name: "ci-ok" }] }
      : request(path);
    const records = await collect("o/a", { request: otherCheck });
    expect(summarizePr(records[1]!)).toMatchObject({ firstPass: true, scored: 1 });
  });

  it("fails instead of emitting partial numbers when attribution is unavailable", async () => {
    const missingIdentity = async (path: string) => path.includes("/check-runs?")
      ? { check_runs: [{ ...runs[0], external_id: null }] }
      : request(path);
    await expect(collect("o/a", { request: missingIdentity })).rejects.toThrow(/attribute/i);
  });

  it("retains filter=all and PR attribution across check-run pages", async () => {
    const paged = async (path: string) => {
      if (path.includes("/check-runs?")) {
        expect(path).toContain("filter=all");
        const page = new URL(path, "https://example.invalid/").searchParams.get("page");
        return { check_runs: page === "1" ? Array(100).fill(runs[0]) : [runs[2]] };
      }
      return request(path);
    };
    const records = await collect("o/a", { request: paged });
    expect(summarizePr(records[1]!)).toMatchObject({ firstPass: true, scored: 1 });
  });
});

describe("parseScore", () => {
  it("reads the title, then the summary heading", () => {
    expect(parseScore({ status: "completed", output: { title: "5/5" } })).toBe(5);
    expect(parseScore({ status: "completed", output: { title: " 4/5 " } })).toBe(4);
    expect(parseScore({ status: "completed", output: { title: "x", summary: "## Paperclip Review — 3/5\n\nbody" } })).toBe(3);
    expect(parseScore({ status: "completed", output: { title: "x", summary: "## Paperclip Review – 2/5" } })).toBe(2);
  });

  it("does not take prose for a score", () => {
    const prose = "## Paperclip Review — Incomplete\n\nThe suites pass 4/5 and I re-read 3/5 files.";
    expect(parseScore({ status: "completed", output: { title: "Incomplete review", summary: prose } })).toBeNull();
    expect(parseScore({ status: "completed", output: { summary: "Reviewed. 4/5 findings fixed." } })).toBeNull();
  });

  it("rejects out-of-range and embedded numbers", () => {
    for (const title of ["6/5", "15/5", "5/50", "5/4", "a5/5", "5/5 done"]) {
      expect(parseScore({ status: "completed", output: { title } }), title).toBeNull();
    }
  });

  it("is null for a run with no output", () => {
    expect(parseScore({ status: "completed" })).toBeNull();
  });
});

describe("classifyReview", () => {
  it("separates the four things a check can be", () => {
    expect(classifyReview(scored(4, "t1"))).toEqual({ kind: "scored", score: 4 });
    expect(classifyReview(manual("t1"))).toEqual({ kind: "manual_required", score: null });
    expect(classifyReview(incomplete("t1"))).toEqual({ kind: "incomplete", score: null });
    expect(classifyReview(running("t1"))).toEqual({ kind: "pending", score: null });
  });

  it("treats the bot's other no-verdict titles as incomplete, not as scored", () => {
    for (const title of ["Review execution did not complete", "Agent finished without a complete assessment"]) {
      const run: Run = { status: "completed", output: { title, summary: `${title}. This check follows the task.` } };
      expect(classifyReview(run), title).toEqual({ kind: "incomplete", score: null });
    }
  });
});

describe("summarizePr", () => {
  it("takes the earliest scored review as the first pass, whatever order runs arrive in", () => {
    const newestFirst = { number: 1, reviews: [scored(5, "2026-10-05T12:00:00Z"), scored(4, "2026-10-05T10:00:00Z")] };
    const oldestFirst = { number: 1, reviews: [...newestFirst.reviews].reverse() };
    for (const rec of [newestFirst, oldestFirst]) {
      const s = summarizePr(rec);
      expect(s.firstScore).toBe(4);
      expect(s.firstPass).toBe(false);
      expect(s.scored).toBe(2);
    }
  });

  it("counts a same-head re-review: an earlier 4/5 is not erased by a later 5/5", () => {
    // One commit, two runs (filter=all returns both): the first scored review
    // decides, so this PR did not pass the first time and took two rounds.
    const s = summarizePr({ number: 5, reviews: [scored(5, "2026-10-07T01:07:47Z"), scored(4, "2026-10-07T01:02:38Z")] });
    expect(s.firstScore).toBe(4);
    expect(s.firstPass).toBe(false);
    expect(s.scored).toBe(2);
  });

  it("sees through a same-head manual-required check to the scored re-review", () => {
    const s = summarizePr({ number: 6, reviews: [scored(5, "t2"), manual("t1")] });
    expect(s.firstScore).toBe(5);
    expect(s.firstPass).toBe(true);
    expect(s.notScored).toBe(1);
  });

  it("passes when the first scored review is 5/5 even if later reviews are lower", () => {
    const s = summarizePr({ number: 2, reviews: [scored(5, "t1"), scored(3, "t2")] });
    expect(s.firstPass).toBe(true);
  });

  it("does not let a leading manual-required check decide the first pass", () => {
    const s = summarizePr({ number: 3, reviews: [manual("t1"), scored(5, "t2")] });
    expect(s.firstCompletedKind).toBe("manual_required");
    expect(s.firstScore).toBe(5);
    expect(s.firstPass).toBe(true);
    expect(s.notScored).toBe(1);
  });

  it("has no first-pass verdict when nothing was scored, and ignores a review in progress", () => {
    const s = summarizePr({ number: 4, reviews: [manual("t1"), incomplete("t2"), running("t3")] });
    expect(s.firstPass).toBeNull();
    expect(s.firstScore).toBeNull();
    expect(s.scored).toBe(0);
    expect(s.notScored).toBe(2);
  });
});

describe("summarize", () => {
  const records: PrRecord[] = [
    { repo: "o/a", number: 1, author: "dev", reviews: [scored(5, "t1")] }, // first pass
    { repo: "o/a", number: 2, author: "dev", reviews: [scored(4, "t1"), scored(5, "t2")] }, // one fix round
    { repo: "o/a", number: 3, author: "dev", reviews: [manual("t1"), scored(3, "t2"), scored(5, "t3")] },
    { repo: "o/b", number: 4, author: "bot", reviews: [manual("t1")] }, // never scored
    { repo: "o/b", number: 5, author: "bot", reviews: [] }, // never reviewed
  ];
  const s = summarize(records);

  it("keeps no-verdict checks out of the pass-rate denominator", () => {
    expect(s.mergedPrs).toBe(5);
    expect(s.prsWithReview).toBe(4);
    expect(s.prsWithScoredReview).toBe(3);
    expect(s.firstPass).toBe(1);
    expect(s.firstPassRatePct).toBe(33.3);
  });

  it("reports the naive reading beside it: first completed check of any kind is 5/5", () => {
    // PRs 1 (yes), 2 (no), 3 (manual first, no), 4 (manual, no) of the four reviewed.
    expect(s.naiveFirstPass).toBe(1);
    expect(s.naiveFirstPassRatePct).toBe(25);
  });

  it("scores a leading no-verdict check as a miss in the naive reading only", () => {
    const one = summarize([{ repo: "o/a", number: 7, reviews: [manual("t1"), scored(5, "t2")] }]);
    expect(one.firstPass).toBe(1);
    expect(one.naiveFirstPass).toBe(0);
    expect(one.naiveFirstPassRatePct).toBe(0);
  });

  it("counts rounds and checks", () => {
    expect(s.scoredRoundsPerPr).toBe(1.67); // scored reviews per scored PR: (1 + 2 + 2) / 3
    expect(s.firstScoreDistribution).toEqual({ "3": 1, "4": 1, "5": 1 });
    expect(s.totalChecks).toBe(7);
    expect(s.notScoredChecks).toBe(2);
    expect(s.completedChecksPerPr).toBe(1.75);
  });

  it("breaks the numbers down by repository and author", () => {
    expect(s.byRepo["o/a"]).toEqual({ prs: 3, scoredPrs: 3, firstPass: 1, scoredRounds: 5 });
    expect(s.byRepo["o/b"]).toEqual({ prs: 1, scoredPrs: 0, firstPass: 0, scoredRounds: 0 });
    expect(s.byAuthor.bot).toEqual({ prs: 1, scoredPrs: 0, firstPass: 0, notScoredRuns: 1 });
    expect(s.byAuthor.dev?.firstPass).toBe(1);
  });

  it("reports n/a, not 0%, when there is nothing to divide", () => {
    const empty = summarize([{ number: 9, reviews: [manual("t1")] }]);
    expect(empty.firstPassRatePct).toBeNull();
    expect(render(empty)).toContain("n/a");
  });

  it("renders the headline numbers", () => {
    const text = render(s);
    expect(text).toContain("first pass (5/5 first):      1 / 3 = 33.3%");
    expect(text).toContain("o/a");
  });
});

describe("parseArgs", () => {
  it("reads every flag", () => {
    expect(parseArgs(["--repo", "o/a", "--repo", "o/b.c", "--limit", "5", "--since", "2026-10-05", "--json"])).toEqual({
      repos: ["o/a", "o/b.c"],
      limit: 5,
      since: "2026-10-05",
      json: true,
      fromFile: null,
    });
    expect(parseArgs(["--from-file", "records.json"]).fromFile).toBe("records.json");
  });

  it("refuses a --since it cannot compare, instead of silently not filtering", () => {
    for (const since of ["10/05/2026", "05-10-2026", "2026-10-5", "yesterday", "2026-13-45"]) {
      expect(() => parseArgs(["--repo", "o/a", "--since", since]), since).toThrow(/--since/);
    }
    expect(parseArgs(["--repo", "o/a", "--since", "2026-10-05T10:00:00Z"]).since).toBe("2026-10-05T10:00:00Z");
  });

  it("refuses a flag with no value, including one swallowed by the next flag", () => {
    expect(() => parseArgs(["--repo"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--repo", "o/a", "--since"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--repo", "--json"])).toThrow(/needs a value/);
  });

  it("refuses a repository that is not owner/name, a bad limit, an unknown flag, and no source", () => {
    for (const repo of ["a", "a/b/c", "/b", "a/"]) expect(() => parseArgs(["--repo", repo]), repo).toThrow(/owner\/name/);
    for (const limit of ["0", "-1", "abc", "1.5"]) expect(() => parseArgs(["--repo", "o/a", "--limit", limit]), limit).toThrow(/--limit/);
    expect(() => parseArgs(["--repo", "o/a", "--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs([])).toThrow(/--repo owner\/name or --from-file/);
  });
});
