# 0001 — Package the router as a Paperclip plugin, configured per company

- Status: accepted
- Date: 2026-08-23

## Context

The router has to be reusable across every company on this PaperclipAI instance
and maintainable independently of any one of them. The alternative on the table
was a set of scripts living inside one company's repository.

Paperclip has a first-class plugin system: plugin capabilities, per-plugin
database namespaces, jobs, scoped API routes, UI slots, and a `managedByPlugin`
field on projects. `PLUGIN_API_VERSION` on this instance is `1`.

The decisive detail, verified in `PLUGIN_SPEC.md` §8 and in the server's
`/api/plugins/:pluginId/config` routes rather than inferred:

> Plugin installation is global and operator-driven. There is no per-company
> install table and no per-company enable/disable switch. If a plugin needs
> business-object-specific mappings, those are stored as plugin configuration or
> plugin state.

Configuration is stored per `(pluginId, companyId)` and read back through
`ctx.config.get(companyId)`.

## Decision

Ship as a plugin. One global install per instance. Every company difference
lives in `instanceConfigSchema` and is written per company through
`POST /api/plugins/:pluginId/config`.

The engine takes `{ descriptor, config, signals }` and **no company id**, so it
cannot special-case a company even by accident. `tests/two-company.spec.ts`
asserts this.

## Consequences

- Onboarding a second company is a config write, not a deploy. That is the
  acceptance criterion for this work and it is now structural rather than
  aspirational.
- A scripts-in-one-repo approach could not have satisfied it: it would have
  needed a copy, and a copy diverges.
- The plugin cannot rely on per-company enablement. `routing.enabled: false` is
  the substitute, and an unconfigured company routes nothing because
  `providers.permitted` defaults to empty and fails closed.
- Anything genuinely instance-wide (which provider serves a model) is out of
  scope here — see [0002](0002-omniroute-is-global-plugin-state-is-per-company.md).
