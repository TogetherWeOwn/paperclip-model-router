# Pacing-misfire response runbook (advise output looks wrong)

On-call response for suspect pacer output. Response only: every step below
is read-only. No step applies a pin, flips a mode, or edits config.

Companion sources: `docs/OPERATIONS.md` ("Capacity-snapshot refresh SLO",
"Expected safety properties"), `docs/operator/TOG-2922-pace-ordering.md`,
`packages/lane-capacity/src/pace.ts`, `packages/lane-capacity/src/burn-alerts.ts`,
`scripts/pacer-policy-replay.mjs`, `scripts/pacer-shadow-diff.mjs`,
`src/enforce-preflight.ts`.

## 0. Rules of engagement

- **Propose-only.** In advise mode the pacer output is a proposal. Nothing
  here steers traffic.
- **No durable hand-repinning.** Model-selection reverts pins, so a manual
  repin silently vanishes and masks the real fault. Do not repin to "fix"
  pacing, not even temporarily.
- **Durable fixes go to TOG-3132.** Anything that needs a code or config
  change is a TOG-3132 candidate, not on-call work.
- **Misfire sightings go to TOG-3020.** Comment only. Never assign it, never
  change its status, never close it — it is a passive channel, not a queue.
- **Independent of TOG-13439.** This runbook works in advise mode today and
  does not wait on selection enforce.

This repository is public. Keep instance links, hostnames, and secret
material out of every log entry and comment written from this runbook.

## 1. Symptoms: what advise is telling you

Advise verdicts are `LanePaceVerdict` records (`pace.ts`): a `state`
(`behind-urgent` | `behind` | `on` | `ahead` | `unknown` | `exhausted` |
`free`), a `reason` (`ok` | `free-lane` | `document-unavailable` |
`snapshot-stale` | `no-records` | `no-computable-governing-window` |
`all-accounts-unserviceable` | `serviceability-window-exhausted`), plus
per-account verdicts and an optional burn score.

| Advise says | Likely meaning | First check |
|---|---|---|
| `unknown` + `document-unavailable` / `no-records` | Lane telemetry missing. A producer gap, not a routing fault. | Source health and lane-document pipeline, not the router. |
| `snapshot-stale` | Refresh cadence cannot sustain the routing mode. | Freshness SLO query, section 3. |
| `no-computable-governing-window` | Window definition and record fields disagree (field mapping or definition drift). | Log to TOG-3020; durable-fix candidate for TOG-3132. |
| `all-accounts-unserviceable` | Every account tripped its serviceability window: lane genuinely down, or windows misdefined. | Provider status first; if the provider is healthy, treat as definition drift (TOG-3132). |
| `serviceability-window-exhausted` | Allowance spent before reset. | Burn-down inputs (utilization/reset field mapping) and `urgentResetSeconds`. |
| `behind-urgent` on a lane that is not burning | Margin or window math is off, or utilization fields are mis-mapped. | Section 2, then log to TOG-3020. |
| `free` on a paid lane, or pace verdicts moving the health-only lane | Lane-definition drift (`free` flag or `pace` block). | TOG-3132 candidate; do not edit the definition from on-call. |
| Shadow and enforce disagree on recorded decisions | Expected during shadow. Single disagreements are not misfires. | Quantify with the shadow diff replay, section 2. |
| `on` / `ahead`, yet quota exhausts early | Margin too thin or utilization under-counted. Defaults reserve reaction lag (`PacePolicy.margin` 0.1; `PACE_TARGET` 0.90), so early exhaustion points at field mapping, not at the margin. | Log to TOG-3020 with the numbers; durable fix to TOG-3132. |

Before anything else, confirm which object looks wrong: the **advise
verdict** (`LanePaceVerdict`) or a **served decision** (decision records
carry `capacity_snapshot_age_ms` / `capacity_snapshot_stale`). A stale
served decision is a refresh problem even when advise is correct.

## 2. Checks (read-only, in order)

1. **Replay the policy table offline.** `node
   scripts/pacer-policy-replay.mjs` replays synthetic capacity states through
   the admit/deny table; exit code 1 on mismatch. Proves the table is
   self-consistent. No live poll, no pacing write, no network.
2. **Diff shadow against enforce on recorded decisions.** `node
   scripts/pacer-shadow-diff.mjs` regenerates
   `docs/operator/pacer-shadow-diff-report.md` from recorded evidence. Read
   the agree/disagree tally and the per-case lane moves before calling any
   disagreement a misfire.
3. **Treat burn alerts as proposals.** `detectBurnAlerts` /
   `emitBurnAlertProposals` (`burn-alerts.ts`) emit per-lane threshold
   proposals only. A fired alert is a signal to investigate, never an order
   to repin or throttle.
4. **Ask the preflight question.** `src/enforce-preflight.ts`: enforce may
   proceed only on a fresh shadow window (at least one shadow sample
   observed within the window). Stale window refuses enforce
   (`shadow-window-stale`). The verb returns a verdict record; it touches
   no live state.

## 3. Freshness SLO (the enforce-readiness gate)

`capacityRouting.maxSnapshotAgeMs` (default 300000 = 5 minutes) is the
freshness backstop: an invocation served from an older snapshot is a
degraded-age invocation. Query per company over the trailing 30 minutes
(full query in `docs/OPERATIONS.md`, "Capacity-snapshot refresh SLO"):

- `stale_share > 0.05`: do NOT promote shadow to enforce. Fix refresh first.
- `stale_share` NULL (zero capacity decisions): not a pass. Widen the
  window or wait for traffic.

Enforce may be *considered* only when all hold: shadow window fresh
(section 2, step 4), `stale_share` at or under 0.05 on real traffic,
shadow/enforce agreement quantified on recorded decisions, and open burn
alerts acknowledged. **On-call never flips the mode.** Record the readings
and route promotion through the TOG-13439 owner path.

## 4. Stop / rollback

Stop immediately on any of these — yours or anyone else's:

- hand-repinning models to "fix" pacing;
- editing capacity config, lane definitions, thresholds, or margins live;
- substituting credentials, restarting refresh loops to "catch up", or
  re-running checks to force green.

Rollback: this runbook makes no changes, so there is nothing to roll back.
If a prior change is suspect, record its revision or SHA and route it to
TOG-3132. Do not revert live config from on-call.

Escalate via an `Operator:` card to the CEO (never the owner) when: the
stale share climbs across consecutive windows, all lanes read `unknown`
at once, or advise disagrees with observed traffic on a lane for more
than one window. Include the readings, not a proposed config edit.

## 5. Logging path

**Misfire sighting → comment on TOG-3020.** Do not assign it. Template:

```text
Misfire sighting (UTC <time>): lane <lane>, advise <state>/<reason>,
snapshot age <ms or "none stored">, traffic showed <one line>,
replay <pass/fail + report link or "not run">.
```

**Durable fix → route to TOG-3132** with symptom, evidence links, and the
suspected fix area (window mapping, margin, refresh cadence, lane
definition). Do not fix it from on-call.

This runbook itself lives at
`docs/operator/pacing-misfire-response-runbook.md`; its review home is
the card that asked for it.
