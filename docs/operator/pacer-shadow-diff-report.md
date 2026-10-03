# Pacer shadow-mode dual-policy diff (offline, recorded decisions)

Baseline (recorded serving policy): capacityRouting.mode shadow + paceOrdering false (recorded serving policy: static cost order; shadow advisory only).

Candidate (promotion): capacityRouting.mode enforce + paceOrdering true (promotion candidate: pace-first ordering over the enforce-usable pool).

Inputs (all recorded, none synthesized):
- pace verdicts: real evaluations of packages/lane-capacity/tests/data/tog2135/claude.json, packages/lane-capacity/tests/data/tog2135/codex.json, packages/lane-capacity/tests/data/tog2135/kimi.json, packages/lane-capacity/tests/data/tog2135/opencode-go.json
  at 2026-09-10T14:53:41.507882Z: claude behind (deviation -0.130); codex, kimi and
  opencode-go ahead (deviations +0.537, +0.118, +0.279). Pinned by tests/pacer-shadow-diff.spec.ts.
- capacity evidence: tests/data/tog1076-live-snapshot.json (recorded live capacity snapshot; per-source first-record values, modelId remapped to case models, all other fields verbatim).
- model table, task classes and per-case roster/descriptor variations: replay harness scaffolding,
  cited per case below. No policy applied, nothing re-admitted.

Result: 7 agree / 5 disagree across 12 recorded decision inputs.

## Agreeing cases

- d04-single-model (Single-model roster: both policies serve claude): both serve claude-model. Single-model roster: no alternative for either policy to prefer.
- d05-quality-floor (Quality floor 85: only opencode-model qualifies): both serve opencode-model. Exacting class floor 85 admits only opencode-model (quality 90). Pace cannot promote across the floor in either policy.
- d06-capability-gate (Vision required: only codex-model qualifies): both serve codex-model. Only codex-model carries vision. Pace cannot promote across the capability gate.
- d07-budget-halt (Budget halt: both policies refuse): both policies refuse (no eligible model). Halt gate refuses non-pinned work under both policies. Null-lane diff reads unchanged.
- d08-stale-pace-aligned (Stale pace verdicts: capacity-utilization fallback agrees with cost): both serve codex-model. Stale pace (no verdicts): candidate falls back to capacity utilization order, which agrees with cost order here (codex util 0.00 first).
- d10-pin-honored (Pin on healthy codex lane: honored by both): both serve codex-model. Healthy-lane pin is honored under both policies.
- d12-sticky-incumbent (Sticky codex incumbent: kept by both): both serve codex-model. Sticky incumbent on a usable lane survives under both policies (stickiness enabled for this case).

## Disagreeing cases (recorded lane -> candidate lane)

### d01-full-roster: Full roster: cheapest model sits on the exhausted kimi lane

- Recorded: kimi-model on cliproxy-kimi.
- Candidate: claude-model on cliproxy-claude.
- Why it moves: pace ordering: claude-model lane behind (deviation -0.130).
- Context: Baseline serves the cheapest model even though its lane reports exhausted; the candidate excludes it and serves the behind-pace lane.

### d02-kimi-lane-down: Kimi lane absent: ahead-lane cheapest vs behind-lane pick

- Recorded: codex-model on cliproxy-codex.
- Candidate: claude-model on cliproxy-claude.
- Why it moves: pace ordering: claude-model lane behind (deviation -0.130).
- Context: Roster variation: kimi lane down for maintenance. Cheapest survivor (codex, ahead) vs behind-pace claude.

### d03-claude-evidence-only: Only claude reports evidence: uncovered cheapest vs covered behind

- Recorded: codex-model on unknown lane.
- Candidate: claude-model on cliproxy-claude.
- Why it moves: pace ordering: claude-model lane behind (deviation -0.130).
- Context: Only the claude lane reports evidence. Baseline still serves uncovered codex on cost; the candidate serves covered, behind-pace claude. Baseline lane is null (no evidence covers codex-model).

### d09-stale-pace-splits: Stale pace: utilization fallback splits from cost order

- Recorded: codex-model on unknown lane.
- Candidate: opencode-model on cliproxy-opencode-go.
- Why it moves: pace ordering: opencode-model lane unknown (capacity-utilization fallback).
- Context: Stale pace with claude+opencode evidence: candidate capacity-orders opencode (util 0.11) over claude (0.56) with uncovered codex last; baseline serves uncovered cheapest codex.

### d11-pin-on-exhausted: Pin on exhausted kimi lane: shadow serves it anyway, enforce diverts

- Recorded: kimi-model on cliproxy-kimi.
- Candidate: claude-model on cliproxy-claude.
- Why it moves: pin refused: kimi-model over weekly utilization cap 0.7 (utilization 1); pace ordering: claude-model lane behind (deviation -0.130).
- Context: Pin refusal is logged under both policies (weekly cap 0.7 vs util 1.00), but only enforce diverts: baseline still serves the refused pin, candidate serves behind-pace claude.

## Reading the split

- The candidate diverts exactly where pace or the enforce gate has a real signal: the behind-pace
  claude lane wins full-roster and reduced-roster cases (d01, d02, d03); the stale-pace fallback
  follows utilization, not cost (d09); the exhausted-lane pin is refused-then-diverted (d11).
- The candidate never promotes across quality, capability, halt, or stickiness gates (d05, d06, d07,
  d10, d12) and never invents a winner when pace is stale but utilization agrees with cost (d08).
- Watch item: d11 logs the pin refusal under BOTH policies but only enforce acts on it — shadow
  keeps serving a pin it just refused. That is the sharpest shadow-vs-enforce behavioral gap found.
