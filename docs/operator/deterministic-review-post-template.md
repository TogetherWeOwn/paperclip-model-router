# Deterministic Paperclip Review post template

**Result:** a host patch that makes every Paperclip Review post render from
structured model fields through deterministic server-side builders. The model
fills fields concisely and never formats markdown; `renderReviewSummary`,
`renderInlineFinding` and `renderCheckSummary` render the summary comment,
inline findings and check-run summary. Each model-controlled field is projected
through the existing publication sanitizer before it is flattened and escaped
as literal Markdown; the caller retains the final whole-post sanitization.
Suggestions containing a backtick fence are omitted rather than allowed to
close the server-rendered block.
Internal Task/Run/history links are omitted. New check-run writes use the public
GitHub pull-request permalink for queued, in-progress and completed checks. While
a check action remains eligible for processing, reconciliation also corrects a
stale Details URL without requiring the action state to change. Already-terminal
actions are not revisited for historical URL backfill.

This repository does not own the Paperclip host source. It tracks the smallest
host patch and its regression coverage as an operator handoff; the patch has no
effect until it is ported and deployed in the host repository. Base: host fork
commit `302776c7878881970c0f37941ba8cd3bc1255138`.

## Problem

Today's review text is free model prose assembled around three literals in
`server/src/services/chat-github-reviews.ts`:

- summary comment: `` ## Paperclip Review — X/5 `` + free `summary`,
  `rationale`, plus internal Task/Run/history links that must never appear in
  public repos;
- inline finding: `**{severity} · {category}**` + free `body`;
- check run: title `X/5` / `Incomplete review`, summary = same free text, and
  `details_url` was an internal board issue link (now a public GitHub PR permalink).

Every review post looks different, low-effort prose ships verbatim, and
internal board links leak into public repos.

## Fix

In `packages/shared/src/types/chat-github.ts` (`GitHubReviewFinding`):

- required `title` (short human-readable finding title);
- optional `evidence` (permalink label or quoted evidence, ≤500 chars);
- optional `suggestion` (replacement lines, rendered as a suggestion block).

In `packages/shared/src/validators/chat-github.ts`:

- Both validators derive from one unrefined strict Zod object shape. New
  submissions use `githubReviewAssessmentSchema`: `summary` ≤2000 chars;
  finding `title` required (1–120, single line, no `|`), `evidence` ≤500,
  `suggestion` ≤4000 without trimming replacement-code whitespace. `line: null`
  remains rejected. This avoids relying on
  `innerType()` to unwrap a refined Zod 4 object.
- Publication and retry use `githubPersistedReviewAssessmentSchema` for stored
  assessments only. It accepts the previous 24,000-character summary bound and
  findings without a title or LEFT-side base filename. It normalizes a missing
  title to its category. A legacy LEFT finding without `basePath` gets an unlinked
  `LEFT side, line N` label rather than a guessed base-side file URL. New LEFT
  findings require `basePath`; new submissions otherwise remain strict.

New `server/src/services/chat-github-review-template.ts`:

- `renderReviewSummary`, `renderInlineFinding`, `renderCheckSummary`
  (check = same rendered summary; title stays `{score}/5` /
  `Incomplete review` at the call site).
- Permalinks use full SHAs: commit `…/commit/{headSha}`, RIGHT-side file
  `…/blob/{headSha}/{path}#L{line}`, and LEFT-side file
  `…/blob/{diffBaseSha}/{basePath}#L{line}`. The compare API resolves the merge
  base from pinned target/head SHAs; submission persists `event.diffBaseSha`
  with the immutable assessment. Publication retries retain that diff base;
  older rows needing a LEFT link resolve it from their stored commit pair.
  Metadata exposes `diffBaseSha`, and `read_file(base)` reads that merge base,
  not the independently advancing target-branch tip. Every new LEFT finding must provide
  `basePath` (equal to `path` when unchanged, or the previous filename for a
  rename) and list it in `coverage.reviewedPaths`. Submission checks the base
  filename against GitHub's `previous_filename` (or the current filename when
  unchanged); coverage accepts both names for permitted renamed files. A
  persisted pre-template LEFT
  finding without `basePath` gets an unlinked `LEFT side, line N` label; the
  renderer does not guess the previous filename. The sanitizer strips URL
  fragments on publish, so the visible `` `path:line` `` label carries the line
  number; tests cover renamed LEFT-side paths and the published (post-sanitizer)
  form.
- Model-controlled titles, categories, paths, keys, body, evidence, summary,
  rationale and limitations pass through `projectSafeChatPublicationText`
  before flattening and Markdown escaping. Suggestions are checked by projecting
  their complete fenced block, preserving indentation. If sanitization would
  change the executable replacement, the suggestion is omitted with a fixed
  explanation instead of publishing edited code. Server-generated permalinks remain clickable;
  model-provided links and formatting do not.
- The caller still sanitizes the completed rendered post before appending its
  idempotency marker. This second pass preserves the existing publication
  boundary, while field-first sanitization prevents escaped punctuation from
  concealing credentials or unsafe URLs.
- Suggestions render in a fenced block unless they contain a backtick fence;
  that unsafe suggestion is omitted with a fixed explanation so it cannot close
  the server-owned block.
- Summary: verdict + score line, commit permalink, files-reviewed count,
  summary, findings table (`#` / severity emoji / title / `path:line`
  permalink), one `<details>` per finding (What / Evidence / Fix +
  `suggestion` block), Coverage line. No Task/Run links.
- Inline: `**🔴 Error · reliability** — {title} · {score}/5 · [`sha7`](commit)`,
  body, Evidence permalink, safe `suggestion` block, `<details>` with long text.
- Truncation at 60,000 chars with `…truncated, see the PR comment`,
  enforced on UTF-16 length (astral emoji no longer push the post over the
  ceiling), cutting only on line boundaries and re-closing any open `<details>`
  block. A suggestion intersected by the cut is omitted in full, never presented
  as an executable partial replacement.

In `server/src/services/chat-github-review-policy.ts` and
`server/src/services/chat-github-reviews.ts`:

- `validateGitHubReviewAssessment` stays strict for fresh model submissions;
  `validatePersistedGitHubReviewAssessment` applies the legacy-compatible schema
  only when the publisher revalidates a stored assessment. Commit, coverage,
  category, and path-policy checks remain shared.
- The three literals call the builders; policy gates, idempotency markers and
  the caller's final publication order remain unchanged (render →
  `projectSafeChatPublicationText` → marker append). Builders also project each
  raw model field through the same sanitizer before Markdown escaping; the
  sanitizer implementation itself is untouched. Queued, in-progress and
  completed check-run writes use a public GitHub PR `details_url`. For eligible
  actions, reconciliation checks on state changes and when a bounded process-local
  cache lacks a recent verification (512 entries, five-minute TTL). The lookup
  requests `filter=all` and paginates up to 100 pages of 100 checks, so a public
  duplicate cannot conceal another matching run's stale URL. A verified stale URL
  is corrected even when action state is unchanged. Already-terminal actions are not revisited
  for historical URL backfill.

In `server/src/services/chat-github-tools.ts` (`submit_review` description)
and `githubReviewPrompt` (`chat-github-review-policy.ts`):

- "Fill fields concisely; never format markdown. The server renders the post."
  Every LEFT-side finding supplies `basePath` at the pull-request base (the
  same as `path` unless the file was renamed) and lists that path in
  `coverage.reviewedPaths`.
- Discovery serves the running server's canonical built-in schema and description,
  so existing bots do not need a configuration save after deployment. Persisted
  catalog status, quarantine, connection and task policy remain the access gates.

## Artifact

From the Paperclip host repository root, apply the artifact using its path in
this checkout (or copy it to the host root and set `PATCH` to that location):

```bash
PATCH=/path/to/paperclip-model-router/docs/operator/deterministic-review-post-template.patch
git apply --check "$PATCH"
git apply "$PATCH"
```

## Verification (host source tree)

```bash
cd server
../node_modules/.bin/vitest run src/services/chat-github-review-template.test.ts
../node_modules/.bin/vitest run src/services/chat-github-check-reconciliation.test.ts
../node_modules/.bin/vitest run src/services/chat-github-review-policy.test.ts
../node_modules/.bin/vitest run src/__tests__/chat-channels.integration.test.ts -t "GitHub agent review workflow"
../node_modules/.bin/tsc --noEmit --pretty false
cd ../packages/shared
../../node_modules/.bin/tsc --noEmit --pretty false
```

New tests exercise each builder with explicit assertions: pass, issues,
incomplete, 0 findings, 300 findings → truncation; assert LEFT-side permalinks
use the full base SHA and previous filename for renames;
verify same-state check-run reconciliation corrects a stale Details URL,
including when a public duplicate run appears first, without changing its
status; the lookup finds matches beyond the first 100 results and stops on a
short page; cache tests cover TTL and LRU bounds; and reject `line: null`.
Renderer regressions verify Markdown/HTML-shaped model text stays
literal, credentials and non-HTTPS URLs are removed through the renderer-to-
sanitizer path, and a suggestion containing a backtick fence cannot close the
rendered block. The 300-finding truncation regression embeds a literal
`</details>` inside the first fenced suggestion and asserts truncation still
closes the real details block. The compatibility regression verifies a
pre-deploy assessment with a 2,001-character summary and no finding title is
rejected by the strict submission validator but accepted by the stored-assessment
validator, which fills the title from the finding category. The integration
regression also accepts a renamed LEFT-side finding, rejects an incorrect base
filename, and checks the published evidence URL at a merge-base SHA distinct
from the target tip. It verifies base-file reads, pinned retry evidence, stale
pre-deploy catalog schemas, and quarantine denial. Replacement regressions cover
significant indentation and omission when sanitization or truncation would alter code.

Verification for patch SHA-256
`97999b5f4d6a8a66fae85ee54463c575903d29a3a41edd27019c3274b8ead77d`:

- Downloaded the public source archive at the pinned host commit into an isolated
  scratch fixture. Regenerated the patch with standard context: 12 host files
  (+1700/−116). Plain `git apply --check` and `git apply` passed on a second pristine
  fixture; all 12 resulting files were byte-identical to the tested source.
- Host unit tests passed: 41/41 across template, reconciliation and review policy.
  Focused host integration passed: 9/9 GitHub workflow tests (1,033 unrelated tests were
  skipped by the explicit name filter). Both `packages/shared` and `server`
  `tsc --noEmit --pretty false` passed with no diagnostics.
- The fixture reused the installed host dependencies through links (Vitest
  4.1.11 and Zod 4.4.3), with workspace links redirected to the pinned source.
  Test processes had live credential and database environment variables removed;
  integration used its isolated embedded PostgreSQL. The live host source was
  not modified. This was source verification, not a deployment.
- Model-router checks passed against the current `origin/main`:
  `npm run typecheck`, `npm test` (106 files, 1,384 tests), `npm run build`,
  `npm run verify:host`, and `npm run rehearse`. The host validator emitted two
  AJV `strictTypes` warnings; all checks passed. These verify the router plugin
  and stock-host probes, separately from the host source tests above.
- The operator port must repeat apply checks and host verification against its
  actual release checkout. The complete host test suite and live deployment
  were not run.

The port PR still needs Paperclip Review 5/5 on its merge head.

Still required after deploy: one live review on a public pull request matching
the template exactly, and a Paperclip Review 5/5 on the port pull request itself.

## Upstream route

Upstream publication goes through the normal audits, steward and operator
review path with public-safe text (no internal ticket ids, links or hosts).
This patch file is the tracked fork input for that route.

## Rollback

Before commit, reverse the patch from the host repository root using the same
artifact path:

```bash
git apply -R /path/to/paperclip-model-router/docs/operator/deterministic-review-post-template.patch
```

After commit, use the host repository's normal `git revert <commit>` path.
Rollback restores free-prose posts, internal Task/Run/history links, and the
prior internal check-run Details URL.
