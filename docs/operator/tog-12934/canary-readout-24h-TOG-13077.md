# TOG-13077 24 h readout (2026-10-03T03:54Z → 2026-10-04T03:54Z)

Cut 2026-10-03T16:43:42Z splits pre-hook baseline (03:54–16:43) from 2×2 phase
(16:43–03:54). Source: heartbeat-runs per agent (`limit=1000&agentId=`, Muse-only
by `usageJson.model`). Method note: list endpoint truncates at 1000/agent;
CodeReviewer hit the cap (995 in-window, pre=0), so replayOFF_hookOFF pre-cut is
undercounted and its post-cut share inflated. All other agents fully covered
(oldest fetched row predates window start).

## 2×2 cells (Muse-model runs only)

| Cell | Runs | Pre | Post | Post Muse | succ | fail | Sonnet | non-Muse other |
|---|---|---|---|---|---|---|---|---|
| replayON hookON (Auto/CoS/CTO/Found/Sec) | 1800 | 561 | 1239 | 1155 | 1668 | 59 | 8 | 18 gpt |
| replayON hookOFF (CEO/Comm/Dir/COO) | 1201 | 585 | 616 | 537 | 1085 | 10 | 4 | 20 gpt |
| replayOFF hookON (Audit/CISO/DevOps/QA) | 1071 | 251 | 820 | 775 | 1011 | 21 | 43 | 0 |
| replayOFF hookOFF (CPO/CR/PM/Web) | 1510 | 103 | 1407 | 1341 | 1425 | 23 | 14 | 0 |

Replay fidelity: ON cells ran `muse-canary(xhigh)` 1662+1052; crossovers tiny
(3+10 spark). OFF cells ran spark 977+1426; Sonnet 43+14 is burn-window residual
(pre-cut) plus a few post-cut strays. Thin tails persist: CoS 1, Community 9,
Audit 2, CPO 3 runs. Volume gate: ~5.6k runs ≫ 600/arm — 48 h decision stands,
no 72 h extension on volume grounds.

## Stop thresholds (agent-visible, all green at 24 h)

- Replay 400s reaching agents: **0**. Text scan of all 113 failed runs for
  `not issued`/`encrypted_content`/`retries_without_replay`: 2 hits, both the
  known `server_error` "model failed to generate a response" payload echo
  (Automation 12:04Z, Founding 05:04Z, both canary-model, pre-cut) — no 400,
  no replay signature. Pre-canary baseline had 6 such 400s.
- Safety-net retries: needs CLIProxy log (operator).
- Canary parks/text-only >30% worse: needs operator notices/parks + end_turn.
  Raw fail-rate flag: hookON cells fail more (ON/ON 3.3%, OFF/ON 2.0%) than
  hookOFF (ON/OFF 0.8%, OFF/OFF 1.5%) — but codes are infra/auth, not model:
  `workspace_validation_failed` 29+2+1+4, `process_lost` 3+3+10+1,
  `setup_failed`, `execution_finalization_deadline_exceeded`, `adapter_failed`
  (empty), `claude_auth_required`.
- `claude_auth_required` (13 ON/ON, 1 OFF/ON): Founding/Automation cases are
  `server_error` echoes above; Security's 10 are **gpt-6.1-sol "Not logged in"**
  (non-Muse, excluded). No canary-Muse auth outage.
- Tool calls/run falls in canary: needs operator query.

## Still needs operator

`muse_replay_hit_rate.py` over `logs/main.log` (24 h + by-hour + reselects +
restart times), notices/parks + tool-calls per Muse run by cell, Keeper tokens
per arm, `summarize-decisions.mjs --since 2026-10-03T16:43:42Z`, transcript
announce share. Non-Muse exclusion applied throughout (Director 16 + Security
14 gpt runs, CEO spark crossover, Sonnet residuals).

Next: decision 48 h ~10-05 03:54Z.
