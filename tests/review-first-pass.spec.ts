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
 * Offline: no GitHub access, only the pure functions.
 */

import { describe, expect, it } from "vitest";

// scripts/ is outside tsconfig's `include` and has no declarations, so resolve
// the module through a computed specifier (same approach as ci-health.spec.ts).
type Run = {
  status: string;
  started_at?: string;
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
};
const spec = "../scripts/review-first-pass.mjs";
const mod = (await import(/* @vite-ignore */ spec)) as Mod;
const { parseScore, classifyReview, summarizePr, summarize, render } = mod;

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
