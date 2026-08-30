# TOG-685 — the `effort` key on the ACP lane

## Symptom

An agent that downshifts to the `cheap` model profile while running on the ACP
engine lane dies and cannot restart itself:

```
ACP session paperclip:<company>:<agent>:<session> does not advertise
config option 'effort'. Supported config options: mode, model.
```

On 2026-08-30 this put Director of Engineering (`0ffb806a`) and Founding
Engineer (`2fe4d7f9`) into `error`. The Director leads 4 of 8 projects, so
company throughput read as "idle" when it was really one config fault.

## Why deleting the key does not fix it

This is the part that matters, and the original issue got it wrong.

`resolveModelProfileApplication` (`/app/server/src/services/heartbeat.ts:3520-3526`)
spreads the **adapter default first** and the stored agent profile second:

```ts
adapterConfig: {
  ...parseObject(adapterProfile.adapterConfig),   // claude_local ships effort: "low"
  ...runtimeProfile.adapterConfig,                // the agent's stored profile
},
```

The claude_local adapter's own default cheap profile carries `effort: "low"`
(`/app/packages/adapters/claude-local/src/index.ts:22-31`). Because the merge is
a shallow spread, **any key the stored profile merely omits is re-supplied by
the adapter default**. Deleting `effort` from the stored profile is cosmetic:
the resolved config still contains `effort: "low"` and the ACP session still
dies.

## The fix that actually holds

Store an explicit falsy value — `effort: ""`. Both lanes guard on truthiness, so
a blank value suppresses the flag on each:

- ACP: `/app/packages/adapter-utils/src/acpx-engine/execute.ts:2137` —
  `if (prepared.requestedThinkingEffort)` before pushing the `effort` option.
- CLI: `/app/packages/adapters/claude-local/src/server/execute.ts:851` —
  `if (effectiveEffort) args.push("--effort", effectiveEffort)`.

The CLI lane therefore keeps working; it simply stops passing `--effort`.

`scripts/strip-effort-fleet.py` performs this as a read-modify-write sweep.
Run it with no arguments for a dry run, `--apply` to write. It is idempotent and
verifies each agent by read-back rather than trusting the PATCH status code.

Two traps the script exists to avoid:

1. **`runtimeConfig` PATCH replaces the whole object.** The `heartbeat` block is
   not uniform across the fleet — paused agents carry a partial
   `{maxConcurrentRuns: 2}`. A hand-written wholesale PATCH silently drops it.
2. **An `enabled: false` cheap profile never enters the merge path** at all
   (`heartbeat.ts:3504-3514` returns early with `adapterConfig: null`), so those
   agents are already safe and must not be "fixed" into an enabled profile.

Regression test: `docs/operator/tog685-effort-merge.test.ts`. It runs against the
real exported adapter profile, so it fails if the adapter default changes. To
execute it, copy into `/app/server/src/__tests__/` and run
`npx vitest run src/__tests__/tog685-effort-merge.test.ts --reporter=default`
from `/app/server` (vitest 4 has no `basic` reporter — `--reporter=basic` dies
with a confusing startup error).

## Recurrence

New agents are **not** exposed. Provisioning writes `cheap: {enabled: false}`
(`/app/server/src/routes/agents.ts:1183`) and never copies the adapter default
into the stored row. The adapter default stays a pure run-time overlay. So the
landmine only arms when someone enables a cheap profile without pinning
`effort`, which is why the permanent correction belongs in the adapter default
itself — tracked separately, since `/app` is not a repo we can commit to from
an agent container.

## Recovering an errored agent

Contrary to the original issue, an agent in `error` **can** be recovered through
the API by a role with board-level authority — the President's key succeeded:

```
PATCH /api/agents/{id}  {"status":"idle","errorReason":null}   -> 200
```

Cross-agent `runtimeConfig` PATCH also succeeded from this role. The 403 the
issue recorded (`agents:suggest-changes requires accepted change consent`) is
role-dependent, not absolute. `POST /api/agents/{id}/wake` and `/restart` are
404; `/resume` exists but returns `403 Board access required`.

Note `errorReason` is a sticky display field: it survives the status reset and
still shows the old message. Judge recovery by `status`, not by `errorReason`.
