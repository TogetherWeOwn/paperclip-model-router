# 0002 — OmniRoute is global; plugin state is per company

> **Superseded by compatible-upstream v1 (TOG-530/TOG-532).** This record is retained as historical context only; its deployment-specific policy is not active product behavior.


- Status: accepted
- Date: 2026-08-23

## Context

Other companies on this instance are live and some have running agents. Two
different scoping models meet in this system:

- **OmniRoute combos and model→combo mappings are global to the proxy.** One
  combo table serves every company. Changing which provider answers a model id
  changes it for everyone, immediately.
- **Paperclip plugin config and plugin state are per company.** They are keyed by
  company id and cannot affect another company's rows.

Conflating the two is how one company's routing change silently breaks another's.
It is also easy to conflate, because from inside a single company both look like
"routing configuration".

## Decision

The plugin picks a **model id** and nothing else. It never picks a provider,
never edits an OmniRoute combo or mapping, and holds no capability that would
let it — its manifest requests no OmniRoute access and no instance-settings
write.

Stated as an invariant:

> A model id is a per-company choice. What that model id resolves to is a global
> fact.

Combo changes remain an operator action through the constrained combo CLI, with
instance-wide blast radius, reviewed as such.

## Consequences

- Adding a model to one company's table is safe and needs no coordination.
- A company table may name a model id OmniRoute does not map. The decision
  succeeds here and fails downstream. `docs/OPERATIONS.md` carries the
  reconciliation checklist; the plugin deliberately does not "fix" this by
  reaching into the proxy.
- The plugin cannot verify that a model is actually servable. That is the price
  of not holding proxy authority, and it is the right trade: an agent-reachable
  component that could redirect all traffic or read provider credentials is too
  much authority for this feature.
- Per-company state (decision log, issue stickiness, quota snapshot) is written
  under `scopeKind: "company"`, never `instance`, so nothing leaks between
  companies. A test asserts one company's decision leaves another's state null.
