# 0003 — Gates are filters, and the tier ceiling yields to the quality floor

- Status: accepted
- Date: 2026-08-23

## Context

The objective is to minimize expected cost **subject to** a hard quality floor
and hard capability/provider constraints. A weighted score that trades quality
against cost is explicitly rejected: it lets cost buy its way past quality.

Two mechanisms in this design both look like "don't go too high":

- the **quality floor** — the minimum a model must be to do this class of work;
- the **tier ceiling** — a cost control, from a task class's `maxTier`, from the
  tier the task scored into, or from budget/quota downshift.

They can contradict. A task class with `qualityFloor: 85` whose task scores into
`standard` has a ceiling below anything that can clear the floor. Under a naive
implementation the result is that no model is ever selected for that class —
a cost control silently blocking all work.

## Decision

Gates are filters in a fixed order, never weights:

1. Rule 0 — does this need a model at all?
2. Hard capability gates — context window, tools, structured output, modality.
3. The Claude block.
4. The quality floor.
5. Cheapest survivor wins.

The tier ceiling is applied **after** all of those, against the set that already
cleared them. If the ceiling would eliminate every qualifying model, the ceiling
lifts to the cheapest tier that can actually do the job, and the trace records
that it lifted and why.

Corollaries:

- **A pin skips the ceiling but no hard gate.** A pin names a model explicitly;
  the ceiling is an estimate and a cost control. A pin that a hard gate rejects
  is refused and the refusal is recorded with its reason — notably, a pin can
  never cross the Claude block.
- **Stickiness is judged against the hard gates**, not the ceiling: throwing away
  the prompt cache is itself a cost. But under budget or quota *pressure*
  (downshift or halt) the incumbent must re-qualify under the lowered ceiling,
  so real cost pressure can still move an issue off an expensive model.
- **Budget halt refuses; it does not downgrade.** Below the floor is not an
  option the router is allowed to take.

## Consequences

- A misconfigured `maxTier` degrades to "the ceiling did not bite" plus a visible
  trace line, rather than to silent total failure.
- Cost control still bites in the case that matters: whenever a cheaper
  compliant option exists.
- The rule is testable and tested — `tests/engine.spec.ts` covers the lift, the
  pin bound, the stickiness/pressure interaction, and the halt-refuses case.
