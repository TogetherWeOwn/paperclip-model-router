# TOG-687 — remove the ACP-fatal `effort` default from the Claude lane

Source-side follow-up to TOG-685, which closed this at the fleet level only.
The deliverable is `TOG-687-claude-local-effort-default.patch` in this
directory. **It is not deployed** — `/app` is a built Paperclip checkout, not a
git repository in the agent containers, so no agent can commit or restart it.

## Two defects, one key

### 1. The adapter default re-supplies `effort` (the issue as filed)

`/app/packages/adapters/claude-local/src/index.ts` declared:

```ts
adapterConfig: { model: "claude-sonnet-4-6", effort: "low" },
```

`resolveModelProfileApplication` (`/app/server/src/services/heartbeat.ts:3520-3526`)
spreads the **adapter default first** and the stored agent profile second, so
any key a stored profile merely omits is re-supplied. TOG-685 wrote an explicit
`effort: ""` onto all 47 agent rows; that holds for rows that exist today.
Enabling a cheap profile later — console, API, or plugin — silently re-arms the
trap, because nothing tells the operator to pin the key.

New agents are provisioned `cheap: {enabled: false}`
(`/app/server/src/routes/agents.ts:1183`) and a disabled profile short-circuits
before the merge, so they were never exposed. That is what kept this
non-urgent, not what made it safe.

### 2. The exposure is wider than the cheap profile (found while verifying)

`effort` is a **documented top-level `claude_local` config field**, and the ACP
lane pushes it at `set_config_option` for every agent except codex
(`/app/packages/adapter-utils/src/acpx-engine/execute.ts`, `sessionConfigOptions`).
`model` is deliberately skipped for claude; `effort` was not.

The Claude ACP backend advertises the `effort` option **conditionally**, on
whether the selected model supports it (`buildConfigOptions` in
`@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:4808-4864`). When it is
not advertised, acpx raises `ACP_BACKEND_UNSUPPORTED_CONTROL`
(`acpx/dist/runtime.js:685`) and the run dies in `configure_session`.

Measured, not inferred — a probe against the real executor with
`{agent: "claude", model: "claude-sonnet-4-6", effort: "low"}` returned:

```
CLAUDE configOptions: [{"key":"effort","value":"low"}]
```

So any `claude_local` ACP agent carrying a top-level `effort` hits this with no
cheap profile involved at all.

## What the patch changes

1. **Drops `effort` from the adapter's default cheap profile.** Setting effort
   per-agent stays supported; it just stops being a default that only one of
   the two lanes can honour.
2. **Degrades an unsupported optional session config option instead of killing
   the run.** A rejected `effort` / `service_tier` / `features.fast_mode` now
   logs to stderr that the setting did not apply and continues.

`model` is deliberately **not** in the optional set. Continuing after a rejected
model would run the turn on a different model, at a different price, while
reporting success — strictly worse than failing. Matching is on the error's
`code` field, not its message text, so an upstream wording change cannot quietly
turn a fatal path into a degradable one.

## Verification

Run against the live `/app` tree, then reversed and `cmp`-verified
byte-identical. The host serves from `/app/server/dist`, so this was
measurement, never a deploy.

| Check | Result |
|---|---|
| `git apply --check` forward on stock `/app` | OK — proves the patch is **absent** from the running host |
| Patch applied, its own 9 tests | 9 passed (4 ACP lane + 5 merge) |
| Full `acpx-engine` suite, patched | 157 passed |
| `claude-local` package + profile/registry server tests | 128 passed, 1 pre-existing failure |
| `tsc --noEmit`, both changed packages | clean |
| `git apply -R`, then `cmp` | both files identical, no test files left behind |

**Mutation controls** — the step that makes the above mean anything. Stock
sources with the new tests kept:

- `tog687-cheap-profile-effort.test.ts` → fails: merged config still carries
  `effort: "low"`.
- `tog687-acp-effort.test.ts` → fails: the rejected-effort run exits 1 instead
  of surviving.

Both pass only with the patch applied, so the tests are load-bearing.

The one failing test in the claude-local package
(`src/server/acp.test.ts` → "reports ACP prerequisites for the ACP lane") fails
**identically on stock sources** and passes in isolation — it is an
environment-dependent probe, unrelated to this change.

## Deploying

Owner of the Paperclip host source. Apply from the repo root:

```
git apply TOG-687-claude-local-effort-default.patch
```

The two added test files carry the regression forward; they are the reason a
future edit to the adapter default fails loudly rather than silently.

After deploy, the `effort: ""` pins TOG-685 wrote to the 47 agent rows become
belt-and-braces rather than the only thing holding the line. They are harmless
and need no sweep to remove — the patch keeps an explicit pin working.
