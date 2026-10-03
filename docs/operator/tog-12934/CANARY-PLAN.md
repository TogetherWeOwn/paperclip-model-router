# TOG-12934 canary plan: does replaying Muse reasoning cut missing-disposition follow-ups?

State at 2026-10-03 03:35Z (operator stage run, [TOG-12960](/TOG/issues/TOG-12960)): image `v8.0.12-tog.3-musereplay-102e4e5b2ea6` is live with the switch OFF, and a `muse-canary` alias with replay ON passed the 8-turn, 7-account probe with zero safety-net retries. No agent runs on `muse-canary` yet. This plan is the 48 h canary (step 3 of the runbook) and what it needs decided.

## What the data says before we start

Measured with `tools/muse_canary_metrics.py` over the 2026-10-02 UTC day (the tool fetches per agent; two agents hit the 1000-row cap, so counts are slightly low). The headline proxy is `finish_successful_run_handoff`, the follow-up wake Paperclip queues when a succeeded run left the card without a valid disposition. It is attributed to the run that caused it and counted against that run's `usageJson.model`.

| Model (succeeded runs, 10-02) | Follow-ups per 100 | 95 % interval |
| --- | --- | --- |
| `muse-spark-1.3-contributor`, n=3,509, 16 agents | **8.69** | 7.80 - 9.67 |
| `claude-opus-5-5`, n=464 | 0.00 | 0.00 - 0.82 |
| `claude-sonnet-5-5`, n=298 | 0.00 | 0.00 - 1.27 |
| `claude-sonnet-5`, n=303 | 0.00 | 0.00 - 1.25 |
| `gpt-6.1-sol`, n=87 | 1.15 | 0.20 - 6.23 |

- The announce-then-stop failure is **Muse-specific**: 305 follow-ups on Muse, 0 on 1,065 Claude runs. That supports the premise of the card.
- Calibration: 6.9 per 100 across all models on the same day, against the operator's 6.2 notices per 100 (352 / 5,662). Same magnitude; I did not reconcile the windows run for run. `issue_continuation_needed` (22 per 100) is a different, broader signal and is not the park metric. **Parks (225 in the baseline) are not in run records**; they must come from the operator's query, grouped by run model.
- **Agents differ 5x on Muse**: 3.0 per 100 (CEO, n=575), 4.8 (Code Reviewer, n=436), 8.3 (Founding Engineer, n=484), 9.9 (Automation Engineer, n=405), 15.9 (DevOps & Reliability Engineer, n=458). So comparing canary agents against different control agents mostly measures the agent. The design below compares each agent with itself.

## Design

- **Arms** are decided by what ran: `usageJson.model` of each run (`muse-canary` vs `muse-spark-1.3-contributor`, effort suffix stripped). Never by what a pin or agent config says.
- **Crossover on the same agents.** Pick N Muse agents. Each alternates `muse-canary(xhigh)` and `muse-spark-1.3-contributor(xhigh)` in 12 h blocks (A B A B = 48 h), so agent and time-of-day effects cancel. Start at 10:05Z or later, after the Claude burn window ends and the fleet is back on Muse; before that there is no like-for-like control.
- **Switching blocks mid-session is safe.** Agent sessions are reused across blocks, so a canary-block history reaches the control model and the reverse. Tagged signatures sent to a model with replay off are dropped, as before the change; see `TestMetaReasoningReplay_DisabledLeavesResponsesUntaggedAndDropsReplay` and `TestMetaReasoningReplay_ModelScope` in the patch series.
- **Size.** At a control rate of 8.7 per 100, a 30 % relative drop needs about 1,580 succeeded runs per arm, 40 % needs 840, 50 % needs 505 (`muse_canary_metrics.py --power --baseline 8.7`). DevOps & Reliability, Founding Engineer and Automation Engineer did 1,347 succeeded runs on 10-02 with a pooled rate of 11.4 per 100; at that rate a 30 % drop needs 1,174 per arm and 40 % needs 625 (`--baseline 11.4`). Three agents therefore give about 1,350 per arm over 48 h, enough for a 30 % drop. Two agents are not enough. Use 3 or more, or extend to 72 h if the interval still overlaps at 48 h. Runs on one card are correlated, so these counts are a floor.
- **How an agent gets the model.** The company runs a fleet-wide default that flips between Muse and Claude in blocks, outside Paperclip's plugin and outside this card, and an agent may only patch its own `adapterConfig` (I will not change another agent's model). So the operator that owns the switcher writes `muse-canary(xhigh)` for the canary agents in canary blocks. Fallback if that is not possible: per-issue `assigneeAdapterOverrides.adapterConfig.model` on newly created cards, accepting that the first run can miss the pin (about 80-90 % land); the arm is still decided by `usageJson.model`. Blocks in which the fleet default is Claude add no runs to either arm; the tool counts only runs actually served on each model.

## Metrics

| Metric | Source | Reading |
| --- | --- | --- |
| Missing-disposition follow-ups per 100 succeeded runs (headline) | `muse_canary_metrics.py --since <start>` | Canary below control, with non-overlapping 95 % intervals |
| Parks per run | operator's baseline query, grouped by run model | Same direction |
| Replay hit rate, safety-net retries | `muse_replay_hit_rate.py` over `logs/main.log` | Retries about 0; hit rate bounds the benefit |
| 400s reaching agents | CLIProxy access log, 400 on `/v1/messages` for Muse | Zero |
| Failed runs, input tokens per run, cost per run | `muse_canary_metrics.py` (medians per arm) | Not worse. Replay puts earlier reasoning back in the prompt, so input tokens can rise; that is Muse quota and I cannot size it from here |
| Text-only `end_turn` rate, tool calls per run | agent transcripts / CLIProxy | Not in run records; operator or CEO-assigned analyst |
| Merged PRs per agent | GitHub | Not worse |

## Checkpoints and decisions

1. **After 4 h:** `muse_replay_hit_rate.py` on the canary window. The stage test forced a new account every turn, so its 3.6 % item hit rate says nothing about production. If the real item hit rate is below about 30 %, the arms will barely differ and waiting 48 h is wasted: stop and build provenance-aware account selection (the follow-up named in the runbook) instead.
2. **Stop at once** (set `meta.reasoning-replay.enabled: false`, hot reload, history stays valid) on any replay 400 reaching an agent, sustained safety-net retries above 1 % of replay requests, failed runs clearly above control, or median input tokens per run more than 25 % above control with no fall in follow-ups.
3. **Expand** (drop the `models` list or widen it) only if follow-ups per 100 fall at least 30 % relative to control, the intervals do not overlap, and the 400 and quota checks are clean. A flat result at underpowered size is inconclusive, not negative.

## Needed before the canary starts

- **CEO:** choose 3 or more Muse agents (the card suggested 2-3; the data above says 3 minimum) and who runs the 12 h alternation. Suggested: DevOps & Reliability Engineer, Founding Engineer and Automation Engineer. They are implementers with high Muse volume and high follow-up rates (more events, tighter intervals); the CEO and Code Reviewer have the lowest rates and set the fleet's pace, so leave them on the control setting.
- **Operator:** confirm the exact string `muse-canary(xhigh)` resolves through the alias (the live Muse model is `muse-spark-1.3-contributor(xhigh)`; I have not probed it and will not use run credentials for another model), and that one run records `usageJson.model` starting with `muse-canary`.
- **Founding Engineer (me):** run the metrics tool at 4 h, 12 h, 24 h and 48 h and post one short comment each time.
