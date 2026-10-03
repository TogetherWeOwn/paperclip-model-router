# TOG-13077 canary measurement plan (rev 2026-10-03 04:20Z)

Canary STARTED by operator on owner order at 03:54Z; EXPANDED 04:05Z. No further pins.
This card is MEASUREMENT only. Prior pin-write failures are obsolete; no pin attempts after 03:54Z.

## Arms (expanded, ~half fleet each)

Canary (replay ON, `muse-canary(xhigh)`): Founding, Automation, Security, CEO,
Director, COO, CTO, Chief of Staff, Community Manager (~3.1k runs/day).
Control (replay OFF, `muse-spark-1.3-contributor(xhigh)`): DevOps, Web, QA,
Code Reviewer, CISO, Prompt & Model, Chief Audit, CPO, Upstream Steward (~3.8k runs/day).

Config: `models: ["muse-canary*"]` (bare `muse-canary` missed the `(xhigh)` suffix).
Backups: `ops/model-floor/backups/canary-before-*.json`, `canary2-before-*.json`.
Rollback: restore backups, or hot-reload `meta.reasoning-replay.enabled: false`.

## Corrected baseline (owner 04:15Z)

First window 03:54-04:01Z: 42 replay requests. All 10 `dropped_foreign` items came
from the operator's deliberately rotating probe (03:54:03-03:54:32). Agent traffic:
0 foreign, 100% same-account replay. 0 safety-net retries, 0 Meta rejections.
Affinity: `GetAndRefresh` sliding 15m TTL, reselect only when bound auth unavailable;
0 "cache hit but auth unavailable" reselections for Meta since 03:54.
Fleet baseline before 10-03: 352 notices / 225 parks per 24h.

## Metrics (Muse-model runs only, by each run's actual model)

- Missing-disposition notices + parks per run, per arm (Paperclip run/event data).
- Text-only end_turn rate, tool calls per run, merged PRs per arm.
- Replay hit rate via `tools/muse_replay_hit_rate.py` over CLIProxy `logs/main.log`.
- 400 safety-net retries (`retries_without_replay`); any replay 400 reaching an agent stops the canary.
- Muse quota/token per arm (Keeper; replay raises input tokens).

Success: >=30% relative drop in (notices+parks)/run canary vs control-flat (+/-15%),
zero replay 400s reaching agents. Stop: any agent-visible replay 400; retries >1% of
replay requests over any 2h; canary parks/text-only >30% worse than control after
150 runs/arm; tool calls/run falls in canary.

## TTL-expiry tracking (owner ask #2) — tool gap

`muse_replay_hit_rate.py --selftest` passes, but replay lines carry only
model/auth/kept/foreign/untagged: no session id, no gap. TTL-expiry vs restart
splits need a session-gap join the current log line cannot do. At each readout report:
overall + by_model/by_auth hit rates, count of `cache hit but auth unavailable`
reselections, and CLIProxy restart times from the log. Ask operator for session-id
enrichment (or a session-gap export) if expiry drops look material; TTL raise to ~2h
is operator hot-reload, not this card.

## Stop hook 2x2 (owner ask #3) — not yet started

Cells: control / hook-only / replay-only / replay+hook, cut at ONE timestamp, hook on
HALF of each arm balanced by run volume, Muse-model runs only, report cells +
interaction, no before/after. Current phase is pre-hook baseline: hook on NEITHER arm
(per confounder rule). The cut needs an operator `Operator:` card to the CEO with the
timestamp + half-arm member lists; do not install unilaterally.

## Confounders

- Burn guard may flip CONTROL (guard-managed muse-spark*) to Sonnet 5.5 briefly after
  the ~06:10Z 5h reset until the weekly cap; canary stays Muse. Filter both arms to
  Muse actual-model runs. Guard window ends 10:00Z.
- Hook on both arms at once or neither (now: neither).
- Readouts: first ~6h (~10:00Z 10-03, doubles as guard-end check), decision 48h
  (~03:54Z 10-05; extend to 72h if either arm <600 runs or <40 baseline events).
