# Deterministic Paperclip Review post template

**Result:** a host patch that makes every Paperclip Review post render from
structured model fields through deterministic server-side builders. The model
fills fields concisely and never formats markdown; `renderReviewSummary`,
`renderInlineFinding` and `renderCheckSummary` render the summary comment,
inline findings and check-run summary. Internal Task/Run links no longer appear
in posts (dropped entirely, per upstream issue #15287's requested setting).

This repository does not own the Paperclip host source, so this is the
smallest exact upstream patch plus executable verification. It has not been
published to a third-party repository. Base: host fork commit
`302776c7878881970c0f37941ba8cd3bc1255138` (fork master, tog.4 item 1).
Tracked for the tog.4 build if ready in time, otherwise the next fork release;
it does not disturb the tog.4 cutover packet.

## Problem

Today's review text is free model prose assembled around three literals in
`server/src/services/chat-github-reviews.ts`:

- summary comment: `` ## Paperclip Review — X/5 `` + free `summary`,
  `rationale`, plus internal Task/Run/history links that must never appear in
  public repos;
- inline finding: `**{severity} · {category}**` + free `body`;
- check run: title `X/5` / `Incomplete review`, summary = same free text.

Every review post looks different, low-effort prose ships verbatim, and
internal board links leak into public repos.

## Fix

In `packages/shared/src/types/chat-github.ts` (`GitHubReviewFinding`):

- required `title` (short human-readable finding title);
- optional `evidence` (permalink label or quoted evidence, ≤500 chars);
- optional `suggestion` (replacement lines, rendered as a suggestion block).

In `packages/shared/src/validators/chat-github.ts`
(`githubReviewAssessmentSchema`):

- `summary` bound tightened to ≤2000 chars (was 24000);
- finding `title` required (1–120), `evidence` ≤500, `suggestion` ≤4000;
- `line` stays a positive int, so `line: null` is rejected (pinned by test).

New `server/src/services/chat-github-review-template.ts`:

- `renderReviewSummary`, `renderInlineFinding`, `renderCheckSummary`
  (check = same rendered summary; title stays `{score}/5` /
  `Incomplete review` at the call site).
- Permalinks use the full SHA: commit `…/commit/{sha}`, file
  `…/blob/{sha}/{path}#L{line}`.
- Summary: verdict + score line, commit permalink, files-reviewed count,
  summary, findings table (`#` / severity emoji / title / `path:line`
  permalink), one `<details>` per finding (What / Evidence / Fix +
  `suggestion` block), Coverage line. No Task/Run links.
- Inline: `**🔴 Error · reliability** — {title} · {score}/5 · [`sha7`](commit)`,
  body, Evidence permalink, `suggestion` block, `<details>` with long text.
- Truncation at 60,000 chars with `…truncated, see the PR comment`.

In `server/src/services/chat-github-reviews.ts`:

- the three literals call the builders; policy gates, idempotency markers
  and sanitizer order are unchanged (render → `projectSafeChatPublicationText`
  → marker append; the sanitizer itself is untouched).

In `server/src/services/chat-github-tools.ts` (`submit_review` description)
and `githubReviewPrompt` (`chat-github-review-policy.ts`):

- "Fill fields concisely; never format markdown. The server renders the post."

## Artifact

Apply [`deterministic-review-post-template.patch`](./deterministic-review-post-template.patch)
at the Paperclip host repository root:

```bash
git apply --check deterministic-review-post-template.patch
git apply deterministic-review-post-template.patch
```

## Verification (host source tree)

```bash
cd server
../node_modules/.bin/vitest run src/services/chat-github-review-template.test.ts
../node_modules/.bin/vitest run src/services/chat-github-review-policy.test.ts
../node_modules/.bin/tsc --noEmit --pretty false
```

New tests snapshot each builder: pass, issues, incomplete, 0 findings,
300 findings → truncation; permalinks use the full SHA; `line: null` is
rejected. Results on the patched tree (patch sha256
`4d2d549d9a403256734d00a3f1e136fec5e7a792cc64e9ed1d379a5594ea0767`):

- `chat-github-review-template.test.ts` + `chat-github-review-policy.test.ts`:
  19 passed (7 new template/schema tests, 12 existing policy tests).
- `tsc --noEmit` on `server`: clean.
- Builder logic additionally verified standalone with node (23/23 assertions:
  pass/issues/incomplete/0/300-truncation cases) before packaging.
- `git apply --check` passes against the five touched host files.

Still required after deploy: one live review on a two-web-next PR matching
the template exactly, and a Paperclip Review 5/5 on the port PR itself.

## Upstream route

Upstream publication goes through the normal audits, steward and operator
review path with public-safe text (no internal ticket ids, links or hosts).
This patch file is the tracked fork input for that route.

## Rollback

Before commit, reverse the patch:

```bash
git apply -R deterministic-review-post-template.patch
```

After commit, use the host repository's normal `git revert <commit>` path.
Rollback restores free-prose review posts (and internal Task/Run links).
