# 0010 — The router does not govern the model agents run on

- Status: accepted
- Date: 2026-08-30
- Issue: TOG-681 §0

## Context

The name "Model Router" invites a reading this component does not support: that
installing it puts one system in charge of model choice on the instance. It does
not. After install, a Paperclip instance has **two independent model-selection
systems that never meet**, and the failure mode is an operator who changes one
expecting the other to move.

### System 1 — how an agent gets its model (host-owned)

This decides which model the agent process itself talks to. It is entirely the
host's, resolved at run start in the heartbeat dispatch path, highest precedence
first:

1. `issues.assignee_adapter_overrides.adapterConfig` — task-level raw override
   (`/app/server/src/services/heartbeat.ts:3534-3539`)
2. `issues.assignee_adapter_overrides.modelProfile` — task-level profile
   (`heartbeat.ts:14137`)
3. wake-context `contextSnapshot.modelProfile` (`heartbeat.ts:3435-3437, 3475`)
4. agent `runtime_config.modelProfiles[key].adapterConfig` (`heartbeat.ts:3527`);
   `enabled: false` there is a **veto** that drops the profile rather than an
   override (`heartbeat.ts:3508-3516`)
5. the adapter's built-in profile `adapterConfig` (`heartbeat.ts:3526`)
6. agent `adapter_config` base (`heartbeat.ts:13774`)

The resolved `config.model` is read at
`/app/packages/adapter-utils/src/acpx-engine/execute.ts:1500` and, for the Claude
adapter, exported as `ANTHROPIC_MODEL` — but only if the config did not already
supply one (`execute.ts:1597-1599`), so an explicit `adapterConfig.env` entry
outranks the resolved profile. `ANTHROPIC_BASE_URL` comes from the adapter
registry's `defaultEnv`
(`/app/packages/shared/src/types/adapter-registry.ts:26`).

None of this is stored by, read by, or visible to this plugin.

### System 2 — the router (this plugin)

The router is an **invocation API**, not a governor. A caller hands it a task
descriptor; it answers with a model id and, on the `invoke` path, performs one
audited upstream call. Its inputs are its own company-scoped
`instanceConfigSchema` — `models`, `taskClasses`, `tiering`, `routing`,
`budget`, `rule0` — and nothing else. It affects exactly the calls made through
it.

## Decision

The router does not attempt to influence System 1, and holds no capability that
would let it.

Concretely: an installed plugin *can* reach System 1, but only through
`agents.managed` (`/app/packages/shared/src/constants.ts:1305`), whose
declarations write `adapterConfig` and `runtimeConfig` onto the agent row
verbatim and unvalidated
(`/app/server/src/services/plugin-managed-agents.ts:103-115`) — which would
include `model`, `env.ANTHROPIC_MODEL`, and `env.ANTHROPIC_BASE_URL`.

**This manifest declares no `agents.*` capability and no `agents` block.** That
is the enforcement: not a promise in prose, but an absent capability the host
would have to grant. The host pairs the two itself — declaring `agents` without
`agents.managed` fails its own manifest validator
(`/app/packages/shared/src/validators/plugin.ts:806-810`) — and
`tests/manifest.spec.ts` asserts both are empty, so acquiring this authority is
a test failure rather than a quiet diff.

## Which decision belongs to which system

| The question | Answered by | Where the operator changes it |
| --- | --- | --- |
| What model does agent X's own process run on? | System 1 | `agents.adapter_config` / `runtime_config.modelProfiles` |
| What model does *this one issue's* agent run on? | System 1 | `issues.assignee_adapter_overrides` |
| Which API endpoint does an agent's own traffic go to? | System 1 | adapter registry `defaultEnv`, or `adapterConfig.env` |
| Which model should a *routed invocation* use for a task class? | System 2 | plugin config `taskClasses` / `tiering` |
| Is a model too expensive, too weak, or out of service for a routed call? | System 2 | plugin config `models`, `budget`; the health probe |
| Should routed spend stop this month? | System 2 | plugin config `budget` |
| Should agent X stop working because the company is over budget? | **Neither** | not a capability either system has |

The last row is the one worth stating out loud. The router's budget halt refuses
*routed invocations*. It does not and cannot stop agents from burning tokens on
their own adapter path — that spend is invisible to it. An operator reading
"budget halt" as "the company stopped spending" is reading System 2's guarantee
onto System 1's traffic.

## Consequences

- Installing the router changes nothing about existing agent behaviour. Nothing
  routes through it until a caller calls it.
- The router's model table can name models no agent will ever run on, and agents
  can run on models absent from the table. Both are correct; they are answers to
  different questions.
- The health probe (TOG-681 §3) takes a model out of service **for routed
  invocations only**. An agent pinned to that same dead model by System 1 keeps
  failing, and the router cannot help it. That is a System 1 alert, not a router
  defect.
- If a future issue genuinely wants the router to govern agent models, that is a
  request for `agents.managed` — a materially larger authority, reviewable as
  such, and it should be argued on its own rather than arrived at by adding a
  capability to fix a bug.
