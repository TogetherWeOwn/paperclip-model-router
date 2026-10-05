# Fleet expansion record — TOG-13077 (2026-10-05 ~04:40Z owner order)

Operator comment `8c5253da` executed the CTO EXPAND verdict (commit `17984c277`).

## What changed (all reversible, logged in operator-actions.log)
1. CLIProxy `meta.reasoning-replay.models` = `["muse-canary*", "muse-spark-1.3-contributor*", "meta/muse-spark-1.3-contributor*"]`, hot reload 04:38Z. Replay now applies to the real model name (log: `model=muse-spark-1.3-contributor kept=… dropped_foreign=0`). Alias kept for rollback.
2. Fleet: `muse-canary-agents.json` active=false. 9 canary agents + 18 idle pins back to `muse-spark-1.3-contributor(xhigh)` — 26 claude_local Muse agents, 0 canary pins. Running runs untouched.
3. Stop hook ON fleet-wide: `MUSE_STOP_GUARD_MAX_NUDGES=0` removed from 8 agents + 7 idle pins. Backups `ops/model-floor/stopguard-*-backup-20261005.json`.
4. Owner rule PR disclosure: "Model Used" names real model + vendor, never `muse-canary`. 24 open PR bodies fixed (before-copies `ops/model-floor/pr-disclosure-fix-20261005/`); all 26 bundles carry the rule. No upstream PR mentioned muse-canary.

## Canary close (measurement complete)
- C1 zero replay-400: PASS (agent 0/605 + operator 0; retries 43/51,459 = 0.08%).
- C2 notices+parks drop: PASS for replay — 69% pooled (71% hookOFF, 54% hookON). Hook alone 47%/17% (floor effect).
- Stops: none tripped (Keeper median fresh-input +12.6% < +25%; parks not worse).

## Fleet watch, 48h (CTO, to ~10-07 04:40Z)
- Fleet-wide Muse notices+parks/run, replay 400s (expect 0), Keeper fresh-input +25% stop.
- Rollback: models back to `["muse-canary*"]` (hot reload) + `active=true` in canary file.
- After clean 48h: Muse per-conversation prompt_cache_key (TOG-13110, merged not deployed) per its recipe. Owner hold until after this test.

No upstream PR from this card. No open PRs on this branch.
