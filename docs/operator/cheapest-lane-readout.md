# T2/T3 cheapest-lane readout (propose-only)

Audit vocabulary: T2 maps to the `strong` tier, T3 to `frontier` on this
repo's small/standard/strong/frontier ladder. Cheapest means the selector's
static cost order (expected cost at the default 8k-in/2k-out mix, quality
breaks ties, then id). Lane-bound presence mirrors the roster row-contract
guard: an enabled row should bind a known lane.

Source: a frozen projection of `tests/data/tog1076-deployed-config.json`
(106 rows) with lane bindings projected from that file's capacity-source
`modelIds` membership onto rows (4 lanes: claude, codex, kimi,
opencode-go). Readout only: no pin, no roster edit, no enforce change.

## Result

| Tier | Eligible | Lane-bound | Cheapest eligible row | Lane | Expected cost |
|---|---|---|---|---|---|
| T2 (strong) | 43 | 37 | deepseek-v4-flash | opencode-go | $0.00308 |
| T3 (frontier) | 45 | 39 | deepseek-v4-flash | opencode-go | $0.00308 |

Gap list on the cheapest rows: none. Both tiers' cheapest eligible row is
enabled and bound to a known lane.

## Observation (not a cheapest-lane gap)

6 enabled rows below the ceilings carry no lane binding, so each is an
unpinned default under the row-contract guard. None is the cheapest in T2
or T3, so cheapest-lane exposure is unaffected:

- standard: gemini-3-flash, gemini-3.1-pro-low, gemini-3.6-flash-high, gemini-3.7-flash-high, gemini-pro-agent
- small: gemini-3.1-flash-lite

Propose-only note: binding or disabling those 6 rows is a durable roster
fix and belongs to the roster owner on the model-selection track, not to
this audit. No serving misfire was observed, so nothing was logged to the
routing-misfire channel.

## Caveats (what this readout does not prove)

- Lane projection is derived from source `modelIds` membership, not verified
  against the assembler's own projection.
- Snapshot currency is unverified: the fixture file may not match the live
  roster at readout time.
- Static policy only: quality floors, capabilities, context windows,
  capacity, pace, pins, stickiness, budget, and fallback gates are out of
  scope by design.

## Reproduce

The vectors in `tests/roster-cheapest-lane.spec.ts` pin the
per-tier cheapest + gap readout on frozen rows; `src/roster-cheapest-lane.ts`
is the pure audit both the spec and this readout run.
