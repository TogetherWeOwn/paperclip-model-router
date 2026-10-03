# FORK-TRACKING — 1001 line (steward-placed content, TOG-13354 run 2026-10-03)

Source: CTO verdicts in `upstream-alignment` on TOG-13346 (rev 612e0cc3),
corrected by the steward file-by-file diff of fork PR #28 vs upstream master
`569c7203` (report: `steward-diff-28.md`). Upstream filing texts:
`upstream-drafts-D1-D10.md` (stage-1 drafts only; the owner batch files them).

Canonical location (to confirm with operator): `ops/paperclip/FORK-TRACKING.md`
in paperclip-ops-tooling. The fork repo root has no `ops/` dir; ops-tooling
owns `ops/`. This copy lives at `docs/operator/tog-13354/FORK-TRACKING.md`
until the operator places it.

| Delta | Fork carrier | Verdict | Exit condition |
|---|---|---|---|
| H1–H7 budgetSpentFraction (SDK + budgets helper + 4 stamp sites + OpenAPI + tests) | #14 → #33 (11 files, +701/−93) | (b) upstream PR (draft D1) | drop fork hunk when upstream merges; upstream has nothing (0 hits @HEAD) |
| H8 action-path stamp | same | (b) as part of D1 | same |
| H9 run-end reap (`cancel-run-invocations` in heartbeat.ts) | same | (c) replace via `agent.run.finished` subscription in router; interim (d) | delete host block when router event-reap ships + 7d zero TTL-orphans; upstream issue D6; router child card filed by steward |
| #27 run-model-decision hook | fork master #27 (merged 2026-10-02, 24 files) | (b) issue-first + #dev (draft D2) | upstream direction; flag stays default-off meanwhile; 0 hits upstream @HEAD |
| #28 sandbox proxy close | #28 commit bf041f69 (= upstream #13777, merged) | (a) on master + (d) 1001 backport | drop when deploy line passes upstream merge |
| #28 sandbox envelope via file | #28 commit d6c35042 (= upstream #13793, merged) | (a) on master + (d) 1001 backport | drop when deploy line passes upstream merge |
| #28 wake-context dedup | #28 commit 19897fd5 (= upstream #13891, merged) | (a) on master + (d) 1001 backport | drop when deploy line passes upstream merge |
| #28 EPIPE runChildProcess guard | #28 commit 068010bf (fork-origin; upstream guard is only in plugin-worker-manager.ts) | (b) NEW upstream PR (draft D10) — ledger (a) corrected | drop fork hunk when upstream merges D10 |
| #28 inherited-env secret denylist | #28 commit d973f642 (fork-origin; upstream `sanitizeInheritedPaperclipEnv` is old shape) | (b) NEW upstream PR (draft D8) — ledger (a) corrected | drop fork hunk when upstream merges D8 |
| #28 tool-gateway MCP shaping | #28 commit 71256d23 (fork-origin; upstream still emits `structuredContent: … ?? null`) | (b) NEW upstream PR (draft D9) — ledger (a) corrected | drop fork hunk when upstream merges D9 |
| #28 launch-env prune + continuation caps | #28 commit db2f82bc (fork-origin; upstream #14092 closed unmerged) | (b) NEW upstream PR (draft D7, supersedes #14092) — ledger (a) corrected | drop fork hunk when upstream merges D7 |
| #29 redaction `{0,64}` bound | #29 (merged 2026-10-02) | (b) upstream PR (draft D3) | drop when upstream merges; upstream still `*` @HEAD — no flip to (a) |
| #30 issue PATCH redacted restore | #30 (merged 2026-10-02); fork #5 closed unmerged | (b) upstream PR (draft D4) | drop when upstream merges; 0 hits upstream @HEAD — no flip to (a) |
| exit-143 cleanup forgiveness | bundle `fix/cleanup-exit-143-success` (unmerged) | (b) fork PR then upstream PR (draft D5, refs #4307 + unmerged #4335) | not in any image until fork PR merges; upstream #4335 closed unmerged — no flip to (a) |

Hard rule restated: no new fork-only Paperclip feature merges without a
recorded (b)/(c)/(d) verdict + evidence above; operator builds only
verdicted deltas.
