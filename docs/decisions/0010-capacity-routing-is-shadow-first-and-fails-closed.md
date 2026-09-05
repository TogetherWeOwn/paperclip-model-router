# ADR 0010 — Model-usage evidence is refreshed separately, shadow-first, and fails closed

## Decision

Usage-aware routing remains one model selector. Every capability, context, budget-halt,
and task-class quality gate runs before capacity evidence. The optional evidence is keyed
to an exact opaque model ID and may rank only models that cleared those gates. Source IDs
and lane labels are sanitized telemetry labels; they do not identify or select the provider
or account that ultimately serves inference.

The feature defaults to disabled and defaults to `shadow` when enabled. The company-scoped
`refresh-capacity` action performs bounded telemetry reads and stores a valid snapshot.
Canonical `invoke` reads only stored evidence and performs no telemetry GET. Shadow records
the evidence-aware alternative while returning the v1 winner. Enforce may change only the
selected model ID and still makes exactly one inference attempt.

Enforce defaults to `fail-closed`. Evidence is usable only when telemetry is available and
health/posture are known and serviceable. The same rule applies to ordinary selection, pins,
stickiness, and fallback. A failed refresh never replaces the last valid snapshot.

## Promotion policy

Promotion is an operator decision, not an automatic state transition or release gate. Do not
set `enforce` until TOG-901/916 supplies trustworthy observations, TOG-251 measures affected
models, every affected model has fresh capacity coverage, a representative shadow window is
clean, and an outage rehearsal proves fail-closed behavior. This record authorizes neither a
public release nor a live installation.

## Undo

Set `capacityRouting.enabled` to `false` to restore the v1 selector. Deployment-provider and
account routing remains entirely inside the configured compatible upstream.
