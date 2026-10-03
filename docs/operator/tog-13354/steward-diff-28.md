# Steward diff: fork PR #28 vs upstream master 569c7203 (TOG-13354, 2026-10-03)

Method: fork #28 commit patches (7 code commits, via company-bot API) vs
upstream master file contents at HEAD `569c7203` (sparse checkout, full blobs)
+ upstream code search (`repo:paperclipai/paperclip`) + upstream PR states via
API. Upstream HEAD is still `569c7203` (the SHA the CTO pinned), so no
verdict flips from master movement.

Caveat: `merge-base --is-ancestor` on `--depth 1` shallow clones returns false
even for true ancestors (truncated history). Ancestry claims below rest on PR
`merged` state + file contents, not on merge-base.

## Per-commit verdicts

| #28 commit | Files | Upstream state @HEAD | Verdict |
|---|---|---|---|
| 068010bf EPIPE stdin guard | server-utils.ts (+25/−3), .test (+111) | `runChildProcess` stdin block is UNGUARDED (no `stdin.on("error")`, no try/catch; `EPIPE`/`stdin.on` = 0 hits in file). Upstream EPIPE guard exists only in `server/src/services/plugin-worker-manager.ts` (plugin-worker path, different code path) | fork-origin → NEW (b), draft D10. Ledger (a) corrected |
| d973f642 secret-strip denylist | server-utils.ts (+70), -env.test (+94) | `sanitizeInheritedPaperclipEnv` is old shape (only `PAPERCLIPAI_CMD` + `PAPERCLIP_*` filter; `DATABASE_URL`/`BETTER_AUTH_SECRET` = 0 hits) | fork-origin → NEW (b), draft D8. Ledger (a) corrected |
| 71256d23 tool-gateway shaping | routes/tool-gateway.ts (+65/−16), services/tool-gateway.ts (+34/−8), test (+215), package.json + lockfile (lockfile hunk later dropped) | routes still emits `structuredContent: result` / `?? null` (lines 180, 202); services line 5886 still `?? null`. `toMcpCallResult` = 0 hits upstream | fork-origin → NEW (b), draft D9. Ledger (a) corrected |
| bf041f69 sandbox proxy close | execution-target.ts (+13/−6), sandbox.test (+54/−3) | = upstream #13777 (merged:true, stats +67/−9 identical, "pre-images identical") | (a) backport, (d) |
| d6c35042 envelope via file | execution-target.ts (+75/−18), sandbox.test (+137/−1), doc (+9) | = upstream #13793 (merged:true, stats +221/−19 identical) | (a) backport, (d) |
| 19897fd5 wake-context dedup | 20 files incl. 10 adapter execute.ts, DEVELOPING.md, SKILL.md | = upstream #13891 (merged:true, stats +156/−75 identical); `PAPERCLIP_WAKE_PAYLOAD_JSON` retired text present upstream | (a) backport, (d) |
| db2f82bc launch-env + continuation caps | remote-execution-env.ts (+152 new), server-utils.ts (+41/−5), ssh.ts (+70/−22), execution-continuation.ts (+164/−39), shared types (+6), heartbeat.ts (+11/−2), tests | `pruneOversizedLaunchEnvWithReport` / `budgetSshRemoteEnvWithReport` / `reservedArgBytes` = 0 hits upstream; upstream `remote-execution-env.ts` is identity-keys-only. Upstream PR #14092 (this exact change) is closed UNMERGED (blocked, closed 2026-10-02). The four SHAs in the commit message (33e7cb4e3…) are fork cherry-picks, not upstream commits | fork-origin → NEW (b), draft D7 superseding #14092. Ledger (a) corrected |
| 7b91be3e lockfile drop | pnpm-lock revert | no-op | — |

## Step-1 re-verification (no flips to (a))

- Upstream HEAD = `569c7203` (unchanged). #29 target still unbounded `*`
  (read verbatim); `restoreRedactedPlainEnvBindings` 0 hits; `budgetSpentFraction`
  / `onResolveRunModel` / `model_decision_pending` 0 hits.
- Exit-143: upstream issue #4307 still open; upstream PR #4335 (adapter +
  heartbeat fix for #4307) is closed UNMERGED (2026-08-01). No (a) flip; D5
  cites both.
- Fork #5 (issue-restore lineage) already closed unmerged; fork #30 merged.
  Ledger "close #5 when upstream PR opens" is moot.
- No open upstream PR proposes the redaction bound (recent "redaction" PRs are
  unrelated). Dedup search done at filing-prep time; filer re-searches titles.

## New (b) split-outs required by this diff

D7 (E2BIG bounds, supersedes #14092), D8 (secret denylist), D9 (MCP shaping),
D10 (EPIPE runChildProcess guard). Texts in `upstream-drafts-D1-D10.md`.
