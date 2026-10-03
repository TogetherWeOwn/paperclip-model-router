# Model-mix drift threshold

Read-only monitoring note for the pinned-vs-unpinned fleet mix snapshot
(`scripts/model-mix-snapshot.mjs`, counting rules in
`scripts/lib/model-mix.mjs`, tests in `tests/model-mix.spec.ts`).

## What the snapshot measures

Over a trailing window (default 24 h), every heartbeat run is joined to its
issue's CURRENT pin (`assigneeAdapterOverrides.adapterConfig.model`):

- **pinned run**: the issue carries a model pin right now;
- **unpinned run**: the issue carries no pin — the run executes under the
  fleet-wide agent default model;
- **unresolvable**: the run has no issue join (dropped from the shares).

The pin side is the same interim current-pin proxy the routing-fidelity job
uses: the per-run decision record does not exist yet, so the mix reflects
pin state at snapshot time, not at run time.

## Why the fleet default matters

Unpinned runs do not go through router policy at all: they inherit the
fleet-wide agent default model, which flips between model families in short
blocks (tens of minutes). In an unpinned-heavy mix (recent windows read
above ninety percent unpinned), the reported-model breakdown therefore
drifts with the fleet default, not with router behavior. A swing in the top
reported model between two daily snapshots is expected whenever the
default flips mid-window — it is a fleet signal, not a router regression.

## Drift-alert threshold (proposed)

Alert when EITHER condition holds on consecutive daily 24 h snapshots:

1. the unpinned run share moves more than **5 percentage points**
   week-over-week; or
2. the top entry of the unpinned reported-model breakdown flips model
   family between consecutive snapshots.

Either condition means the fleet default moved under an unpinned-heavy mix.
Neither condition on its own implies a router regression; treat the alert
as a prompt to re-read the fidelity readout, not as a routing defect.

## Latest snapshot

Window 2026-10-02T23:17:11Z → 2026-10-03T23:16:33Z (24 h, generated
2026-10-03T23:27:59Z). Method: one newest-1000 heartbeat-runs page per
agent (27 agents), deduped by run id, windowed client-side on createdAt.

- Distinct runs: 5026 across 1549 issues; 0 unresolvable, 0 undated.
- Pinned runs: 438/5026 (**8.7%**); unpinned runs: 4588/5026 (**91.3%**).
- Pinned issues: 68; unpinned issues: 1481.
- Runs without a reported model: 402 (counted separately, never as matches).
- Reported-model top entries overall: muse-spark(xhigh) 1966,
  muse-canary(xhigh) 1850, claude-sonnet-5-5 547.
- Unpinned reported-model top entries: muse-spark(xhigh) 1880,
  muse-canary(xhigh) 1656, claude-sonnet-5-5 454 — the two leaders sit
  within ~12% of each other, the expected signature of the flipping fleet
  default under an unpinned-heavy mix.
- Truncated: one high-volume reviewer agent returned a full 1000-row page
  reaching back only to 2026-10-03T03:50:05Z, so its older in-window runs
  are not counted; the unpinned share is a lower-bound proxy for that
  agent's slice.
