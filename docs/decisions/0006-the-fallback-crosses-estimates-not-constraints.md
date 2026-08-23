# 0006 — The fallback crosses estimates, not constraints

Status: accepted
Date: 2026-08-23
Supersedes nothing. Amends the ungated-fallback position recorded in the
TOG-156 handoff and refines [0003](0003-gates-are-filters-and-the-ceiling-yields-to-the-floor.md).

## Context

`routing.fallbackModelId` exists so a company can choose a floor rather than a
failure: if nothing in the table survives the gates, return *something* instead
of stranding the work. Through `v0.1.1` it was deliberately ungated, and that
was written down as a known choice.

The independent review in TOG-228 asked for a second opinion on the choice, and
the second opinion is that "ungated" was doing more than it was meant to. It was
reproducible on `v0.1.1` that:

- With Claude PAYG off and `teamclaude` removed from `providers.permitted`,
  every Claude model in the table is rejected at `claude-block` — and a
  `fallbackModelId` of `claude-opus-5` was still returned as `selected`.
- With the pooled teamclaude quota reported exhausted and
  `gates.claudeQuota: "halt"`, the same fallback was still returned.

Rule 1 is the one rule in this plugin described as non-negotiable. A fallback
that crosses it is not an escape hatch from an estimate; it is a hole. And the
worst version is a `fallbackModelId` that is not in the model table at all,
because then no gate has ever looked at it: an operator can name any model id
they like and the router will hand it to OmniRoute unexamined.

## Decision

Gates are sorted into two kinds, and the fallback may cross exactly one kind.

**Estimates — the fallback may cross these.** They are judgements about whether
a model *fits* the task, and being wrong about them costs quality, which is the
trade the fallback exists to make:

- `tier-ceiling` — a cost control derived from a score.
- `quality-floor` — this company's judgement of what the class needs.
- `capability`, `context-window` — what the caller *believes* the task needs.

**Constraints — the fallback may not cross these.** They are not judgements
about fit. Each is a statement that this company may not be served by this model
at all, and being wrong about them costs money to a provider nobody approved, or
sends a prompt somewhere it was not permitted to go:

- `claude-block` — Rule 1.
- `provider-not-permitted` — the company's approved provider list.
- `quota-gate` — the pooled quota this model draws on is exhausted.
- `not-in-table` — no gate has vetted this id, so all of the above are unknown.

A fallback rejected at any constraint yields `no-eligible-model`, with the
blocking stage and reason in the trace.

Two supporting changes follow from the last bullet. `onValidateConfig` treats a
`fallbackModelId` outside the model table as an **error** rather than a warning,
so the operator finds out at configuration time. And `RoutingDecision` carries
`fallbackUsed: boolean`, because a fallback is `outcome: "selected"` for a model
that did *not* clear the capability, context or quality checks — a caller that
reads only `outcome` would otherwise believe the model can do the job.

## Consequences

A company can still be stranded, and now it can be stranded in one more way: a
fallback naming a model the company is not permitted to use is refused rather
than served. That is the intended trade. `no-eligible-model` is an escalation
signal the caller must handle; a Claude model quietly served by an unapproved
PAYG provider is an incident, and the plugin cannot tell which one the operator
would have preferred at 3am. It refuses.

Related: the **budget halt** was moved above the stickiness and fallback
branches in the same change. It had been evaluated after both, so a halted
company kept spending through either. A pin is still the one documented
exception to a halt, and that is unchanged.
