# TOG-13077 first readout — ~6 h (03:54–10:00Z 2026-10-03)

Scope: expanded 9v9 arms. All run figures are heartbeat-runs with
`startedAt >= 2026-10-03T03:54Z`. Model filter per design: Muse-model runs only.

## Arms verified live

Canary agents route to `muse-canary(xhigh)` (event `PAPERCLIP_ASSIGNED_MODEL`
sample, latest 2 finished runs each): Founding, Automation, Security, Director,
COO, CTO all canary. Control agents route to `muse-spark-1.3-contributor(xhigh)`:
DevOps, Web, QA, Code Reviewer, CISO, Prompt&Model all spark. No Sonnet in the
sample — the post-06:10Z burn-guard flip either did not fire or needs a
full-window audit at the 24 h readout.

Two anomalies (both excluded by the Muse-only rule, flagged for operator):
- CEO latest run (10:00Z) routed `muse-spark…` while the prior ran canary —
  likely a new/changed issue missing the override. Check CEO issue overrides.
- Director one run routed `gpt-6.1-sol` (non-Muse, excluded).

Pins: canary exposure rides per-issue `assigneeAdapterOverrides`
(`model: muse-canary(xhigh)` confirmed on Founding overrides); base agent models
are empty fleet-wide so guard-end rewrites do not apply to canary pins.

## Volumes (balanced: +19%, within the 30% swap rule)

| Arm | Runs | succeeded | failed | cancelled | running |
| --- | --- | --- | --- | --- | --- |
| Canary (9) | 487 | 455 | 28 | 7 | 3 |
| Control (9) | 409 | 397 | 5 | 6 | 1 |

Per agent: Founding 153, CEO 136, Automation 64, Security 61, Director 32,
COO 28, CTO 13, Chief of Staff 0, Community 0 / Code Reviewer 233, DevOps 101,
Web 25, Prompt&Model 20, CISO 17, QA 9, Upstream 2, CPO 1, Audit 1.
Zero-run members (Chief of Staff, Community) vs control's thin tail
(CPO/Audit/Upstream ≤2) roughly offset; revisit pair balance at 24 h.

## Failures: infra, not model

All 28 canary + 5 control failures are `workspace_validation_failed`
(shared-worktree branch collisions, known infra issue), plus one Founding
`adapter_failed` (empty) and one `server_error` ("model failed to generate a
response", 05:04Z). No failure mentions replay or affinity.

## Stop thresholds (all green at 6 h)

- Replay 400s reaching agents: **0 of 897 runs scanned** (`not issued to this
  caller` absent; the one `encrypted_content` hit is a `server_error` payload
  echo, verified). Pre-canary baseline had 6 such 400s on Founding (00:45–01:08Z).
- Safety-net retries: needs CLIProxy log (operator). Agent-side proxy: 0 replay
  400s.
- Canary parks/text-only >30% worse than control: needs operator
  notices/parks + end_turn queries (not yet run).
- Tool calls/run fall: needs operator query.

## Still operator-owned (not measurable from here)

- `muse_replay_hit_rate.py` over `logs/main.log` (6 h window) + retry rate.
- Notices/parks per run, text-only end_turn rate, tool calls/run, merged PRs
  per arm; Muse quota/tokens per arm (Keeper).
- TTL-expiry split (session-gap join missing from log lines) and restart times.
- Stop-hook 2×2 cut (pending operator card to CEO; currently hook on neither arm).

## Next

- Operator: 6 h replay hit-rate + retries; notices/parks per arm; CEO override check.
- 24 h readout (~10-04 03:54Z): full-window Sonnet audit, pair rebalance if the
  thin tails skew, TTL materiality call.
- Decision 48 h (~10-05 03:54Z; extend to 72 h if either arm <600 runs or
  <40 baseline events — on pace: ~6 h yielded ~900 runs).
