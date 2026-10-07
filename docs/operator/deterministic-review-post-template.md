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
Internal Task/Run/history links are omitted. The check-run Details URL is the
public GitHub pull-request permalink for queued, in-progress and completed
checks, so a completion update replaces any stale internal URL.

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
  `suggestion` ≤4000. `line: null` remains rejected. This avoids relying on
  `innerType()` to unwrap a refined Zod 4 object.
- Publication and retry use `githubPersistedReviewAssessmentSchema` for stored
  assessments only. It accepts the previous 24,000-character summary bound and
  findings without a title, normalizing a missing title to its category. New
  submissions remain strict.

New `server/src/services/chat-github-review-template.ts`:

- `renderReviewSummary`, `renderInlineFinding`, `renderCheckSummary`
  (check = same rendered summary; title stays `{score}/5` /
  `Incomplete review` at the call site).
- Permalinks use the full SHA: commit `…/commit/{sha}`, file
  `…/blob/{sha}/{path}#L{line}`. The sanitizer strips URL fragments on
  publish, so the visible `` `path:line` `` label carries the line number;
  tests assert the published (post-sanitizer) form.
- Model-controlled titles, categories, paths, keys, body, evidence, summary,
  rationale and limitations pass through `projectSafeChatPublicationText`
  before flattening and Markdown escaping. Suggestions are sanitized before
  entering their code block. Server-generated permalinks remain clickable;
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
  ceiling), cutting only on line boundaries and re-closing any open fence or
  `<details>` block.

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
  completed check runs use a public GitHub PR `details_url`; the completion
  update overwrites any stale internal URL.

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
../node_modules/.bin/vitest run src/__tests__/chat-channels.integration.test.ts -t "public PR URL|task-bound bot tools"
../node_modules/.bin/tsc --noEmit --pretty false
```

New tests snapshot each builder: pass, issues, incomplete, 0 findings,
300 findings → truncation; permalinks use the full SHA; `line: null` is
rejected. Renderer regressions verify Markdown/HTML-shaped model text stays
literal, credentials and non-HTTPS URLs are removed through the renderer-to-
sanitizer path, and a suggestion containing a backtick fence cannot close the
rendered block. The 300-finding truncation regression embeds a literal
`</details>` inside the first fenced suggestion and asserts truncation still
closes the real details block. The compatibility regression verifies a
pre-deploy assessment with a 2,001-character summary and no finding title is
rejected by the strict submission validator but accepted by the stored-assessment
validator, which fills the title from the finding category. Results (patch sha256
`a41bc2f6fd65f2bb8f9a6844dc844c44ec9f0ee2cc1573186b098b5f8f352ec2`):

- `git apply --check` and application passed against the pristine host fixture
  at base commit `302776c7878881970c0f37941ba8cd3bc1255138`; the applied tree
  exactly matched the expected ten-file result.
- esbuild syntax transforms passed for all 10 patched host TypeScript files.
  The standalone 300-finding truncation smoke passed at 58,034 UTF-16 units;
  it kept the suffix and balanced fences, and closed the real details block
  after a suggestion's literal `</details>` lookalike. Its fixture had no
  secret-like values, so that smoke did not exercise credential redaction.
- `tsc --noEmit --strict` passed for the shared validator in the compatibility
  revision; the validator is unchanged in this renderer revision.
- Four standalone schema assertions passed: strict input rejects legacy data,
  stored parsing accepts it and preserves the summary, derives a title, and
  still rejects `line: null`.
- Host Vitest and full server typecheck were not run in this model-router
  workspace. The operator port must rerun them against the host checkout.

Earlier rev-2 evidence was 27/27 standalone behavioral assertions, with the
host Vitest and full server typecheck deferred to the operator port. The port PR
still needs Paperclip Review 5/5 on its merge head.

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
Rollback restores free-prose posts, internal Task/Run/history links, and the
prior internal check-run Details URL.
