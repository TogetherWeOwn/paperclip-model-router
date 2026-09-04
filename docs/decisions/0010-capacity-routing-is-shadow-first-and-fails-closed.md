# ADR 0008 — Capacity routing is shadow-first and fails closed

## Decision

Usage-aware routing is an extension of the existing selector, not a second router.
The quality floor and hard gates run first. Provider/account capacity ranks the
survivors afterwards.

The feature defaults to disabled; when enabled it defaults to `shadow`. Shadow mode
records the capacity-aware alternative while returning the v1 selection. Promotion to
`enforce` is a config change backed by explicit comparison evidence, not an automatic
state transition.

In enforce mode the default no-telemetry behavior is `fail-closed`. Unknown capacity is
not healthy capacity. Operators may choose `exclude-lane` only when independent sources
cover the remaining lanes.

## Why

TOG-251 remains the authority for measured task-class quality. Usage pressure may choose
between models above that floor; it may not lower the floor. TOG-930 established that
catalogue presence is not health evidence, and TOG-358 requires live enforcement to fail
closed when usage telemetry is unavailable.

The router records requested and selected identities separately from observed serving
identity. TOG-901/916 are not deployed, so missing serving evidence remains null rather
than being inferred from the request.

## Undo

Set `capacityRouting.enabled` to `false` to return to the v1 selector. No model table,
quality floor, provider rule, or existing quota gate changes are required.
