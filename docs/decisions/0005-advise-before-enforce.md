# 0005 — Advise before enforce

> **Superseded by compatible-upstream v1 (TOG-530/TOG-532).** This record is retained as historical context only; its deployment-specific policy is not active product behavior.


- Status: accepted
- Date: 2026-08-23

## Context

The router's output is a `{ model }` that should end up on an issue's
`assigneeAdapterOverrides.adapterConfig`, where the adapter reads it.

Checked against the installed SDK (`@paperclipai/plugin-sdk@2026.817.0`) rather
than assumed:

- `PluginIssuesClient.create()` accepts `assigneeAdapterOverrides`.
- `PluginIssuesClient.update()` does **not**. Its patch type is
  `Partial<Pick<Issue, "title" | "description" | "status" | "priority" |
  "assigneeAgentId" | ...>>` plus relations, labels and workspace fields.
  `assigneeAdapterOverrides` is absent, and the same absence is present in
  `protocol.ts` and `worker-rpc-host.ts`.

So a plugin worker can set a model on an issue it creates, and cannot set one on
an issue that already exists — which is the case that matters, because routing
decisions are made for work that is already on the board.

Two adjacent facts from the substrate work constrain the alternatives. The
adapter rejects any `adapterConfig` key other than `model` — writing `effort`
is unconditionally fatal on the Claude adapter — and a per-issue model override
is silently ignored if `ANTHROPIC_MODEL` is set in the environment. Neither is
something this plugin can paper over.

## Decision

Ship `0.1.0` with `routing.mode: "advise"` as the real behaviour: every decision
is computed, recorded in company-scoped state with its full trace, and returned
to the caller through the tool, the action, or the scoped API route. The caller —
an agent, or an operator — applies it.

`routing.mode: "enforce"` exists in the config contract and currently behaves as
`advise`. It is not removed, because the contract should not have to change when
the host gains the write path; and it is not silently pretended, because a mode
that claims to enforce and does not is worse than one that says it does not.

## Consequences

- The plugin is useful now: a routing decision an agent can ask for and act on,
  with an auditable reason, is most of the value.
- The gap is a host limitation, not a design choice here. Closing it needs either
  `assigneeAdapterOverrides` added to the SDK's issue-update patch, or a
  first-party route the plugin may call. That is tracked as follow-up work
  against the Paperclip platform, not worked around with a capability this plugin
  should not hold.
- When the write path lands, `enforce` becomes a behaviour change inside an
  existing config key: no company reconfiguration, and a `MINOR` version bump.
- Nothing in this decision affects the Claude block or any other gate. A decision
  that is only advisory is still a decision that refused to route Claude off
  teamclaude.
