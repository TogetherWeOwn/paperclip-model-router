# TOG-13077 48 h readout (2026-10-03T03:54Z → 2026-10-05T03:54Z)

2×2 phase = post-cut 2026-10-03T16:43:42Z → 48 h mark. Source: heartbeat-runs
per agent (`limit=1000&agentId=`, Muse-only by `usageJson.model` startswith
`muse-`). All counts are lower bounds: high-volume agents hit the 1000-row cap.

## Coverage caveat (truncation)

Oldest fetched row per agent (anything earlier is uncounted here):

- Automation 10-04T02:00Z, Founding 10-03T20:59Z, CEO 10-03T23:15Z,
  DevOps 10-04T00:52Z, Code Reviewer 10-04T12:13Z → their CUT→24 h slices are
  partial. CoS/Community/Audit/CPO fully covered (thin tails).
- Pre-cut totals below are therefore undercounted; post-cut Muse totals are
  lower bounds but still ≫ volume gate.

## 2×2 cells, post-cut Muse-model runs only

| Cell | Post Muse | succ | fail | fail% | Post model mix (all models) |
|---|---|---|---|---|---|
| replayON hookON (Auto/CoS/CTO/Found/Sec) | 1383 | 1373 | 10 | 0.72% | canary 1383, sonnet 591, gpt 359, no-model 284 |
| replayON hookOFF (CEO/Comm/Dir/COO) | 850 | 847 | 3 | 0.35% | canary 849, spark 1, sonnet 367, gpt 231, no-model 250 |
| replayOFF hookON (Audit/CISO/DevOps/QA) | 1013 | 1001 | 12 | 1.18% | spark 1013, sonnet 361, gpt 265, no-model 153 |
| replayOFF hookOFF (CPO/CR/PM/Web) | 1035 | 1018 | 17 | 1.64% | spark 1035, sonnet 530, gpt 179, no-model 357, other 31 |

Replay fidelity held: ON cells ran canary 1383+849 with ≤1 spark crossover;
OFF cells ran spark 1013+1035 with 0 canary crossovers. Volume gate passed:
replayON 2233, replayOFF 2048 post-cut Muse runs (need 600/arm) — no 72 h
extension on volume grounds.

Per-agent post-cut Muse (succ/fail): Auto 507/1, CoS 2/0, CTO 101/0,
Founding 612/7, Security 151/2; CEO 508/2, Community 9/0, Director 186/1,
COO 144/0; Audit 1/0, CISO 89/0, DevOps 569/7, QA 342/5; CPO 6/0,
Code Reviewer 324/0, Prompt&Model 337/10, Web 351/7.

## Day split: Day 2 model drift (confounder)

- CUT→24 h (10-03 16:43 → 10-04 03:54): ON/ON canary 645, ON/OFF canary 335,
  OFF/ON spark 397, OFF/OFF spark 391; Sonnet 0, gpt ≤16. Clean Muse window.
- 24 h→48 h (10-04 03:54 → 10-05 03:54): Sonnet 591+367+361+530 and
  gpt 343+229+265+179 appear in ALL cells, plus no-model surge. The
  "fleet on Muse until Mon 00:00Z" premise did not hold on Day 2.
- Muse-only comparison stays valid (above), but Day 2 Muse volumes are a
  subset of fleet activity; control-arm flatness for notices/parks must be
  judged on Muse-only runs by the operator.

## Stop thresholds (agent-visible)

- Replay 400s reaching agents: **0**. Scanned 605 post-cut failed runs (all
  models) for `not issued to this caller` / `retries_without_replay` /
  `safety-net` / `dropped_foreign`: zero hits. 5 `claude_transient_upstream`
  hits carry `encrypted_content` only as part of the known `server_error`
  "model failed to generate a response" payload echo (Founding 10-04, CEO ×2,
  DevOps, Web) — same benign echo as the 24 h readout, not a 400.
- Post-cut Muse fail codes: `adapter_failed` (empty "Adapter failed", no
  stderr) 8+1+11+16; `claude_transient_upstream` 1+2+1+1 (the echo above);
  `claude_auth_required` 1 (ON/ON). No replay signature in any.
- Fail-rate pattern flipped vs 24 h: replayON now fails less than replayOFF
  within both hook strata (0.72 vs 1.18 hookON; 0.35 vs 1.64 hookOFF), but
  codes are infra/transient, and truncation biases the comparison — do not
  claim a replay reliability win from this alone.
- Parks / text-only >30% worse, tool calls/run, notices+parks per run:
  need operator queries (unchanged).

## Still needs operator (unchanged list)

`muse_replay_hit_rate.py` over `logs/main.log` (48 h + by-hour + reselects +
restart times), notices/parks + tool-calls per Muse run by cell, Keeper tokens
per arm, `summarize-decisions.mjs --since 2026-10-03T16:43:42Z`, transcript
announce share. Non-Muse exclusion applied throughout.

## Verdict vs CEO criteria

- Zero replay 400s reaching agents: PASS (agent-visible).
- ≥30% (notices+parks)/run drop, control flat: UNDECIDED — needs operator.
- Recommendation: **conditional expand** pending operator numbers; if
  notices/parks confirm ≥30% drop with control flat and hit-rate/retries stay
  green, CEO may expand (`models` list to every Meta model). If operator
  numbers miss, extend 24–48 h on Muse-only comparison (Day 2 drift argues
  against a blind 72 h rollup). Do not start the upstream PR; audits →
  Steward → CEO path stands.
