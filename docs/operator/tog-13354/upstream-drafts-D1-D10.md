# Upstream filing drafts D1–D10 — ready-to-click texts (TOG-13354, steward run 2026-10-03)

Stage-1 rule: NOTHING here is filed by the steward. Each item below is the
exact title + body + target URL + branch name, no-leak-checked, for the owner
batch via the CEO. Filer replaces every `[FILER: …]` slot (model ID,
verification outputs) at filing time and re-runs the dedup search on exact
titles before clicking.

No-leak check (all drafts): no `TOG-`/`PAP-` IDs, no private URLs, no
hostnames, no agent names, no secrets. Branch names are `type/short-slug`.

Filing order (dependency-safe): D6 + D2 are issues (no code); D3, D4, D5, D7,
D8, D9, D10, D1 are PRs ported from the fork onto upstream master — each
needs its code branch prepared by an engineer before the owner clicks.
Suggested click order: D6, D2 first (discussion), then small fixes
D3 → D8 → D10 → D9 → D4 → D5 → D7, then D1 (largest).

---

## D1 — PR: host-computed budget spend fraction

- Target: open PR against `paperclipai/paperclip` `master`
  (`https://github.com/paperclipai/paperclip/compare`)
- Branch: `feat/host-budget-spend-fraction`
- Title: `feat(plugins): inject host-computed budget spend fraction on tool and action paths`

Body:

```md
<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - Plugin tool and action handlers receive a run context from the caller
> - That context is caller JSON, so any caller can forge a spend value
> - A forged low value dodges a halt gate, and a forged high value forces a downshift
> - The control plane owns budget policy, so the host must stamp the true value and overwrite the caller value
> - An optional field keeps this non-breaking for existing plugins
> - This pull request adds that host-stamped field on the tool and action paths
> - The benefit is budget gates read a value the caller cannot forge

## Linked Issues or Issue Description

No existing upstream issue describes this gap, so it is described here.
Related roadmap area: Better Budgeting (spend visibility and safer hard
stops). No duplicate PR found (searched `budgetSpentFraction`,
`runBudgetSpentFraction` — zero hits). Re-search exact title at filing time.

**What happened?**
The router budget gates consumed a caller-supplied spend fraction. A caller
could understate spend to dodge a halt or overstate it to force a downshift.

**Expected behavior**
The host computes the spend fraction from its own billing envelopes and
stamps it onto the context. The forged value never reaches a gate.

**Steps to reproduce**
Send a tool call whose run context carries a forged low spend fraction.
Observe the gate reading the forged value instead of the true spend.

**Paperclip version or commit**
`[FILER: master SHA at branch time]`

**Deployment mode**
Self-hosted server.

## What Changed

- Added optional `budgetSpentFraction` to `ToolRunContext` and to the plugin
  action actor context (`PluginPerformActionActorContext`).
- Added a `runBudgetSpentFraction` helper: it reads the most specific active
  `billed_cents` envelope, prefers monthly scope, and returns
  `observed / amount`, else `undefined`.
- Stamped the value on the tool-gateway primary path. Overwrote the caller
  value with spread on the plugin-route and dispatch paths. Stamped the
  action actor context with agent-to-company fallback.
- Dropped non-finite values at the worker shim. Absent field means not
  injected.
- Extended the OpenAPI schema for the new optional field.

## Verification

- `[FILER: forged-value-loses test + suite name and result]`
- `[FILER: undefined-passthrough test + suite name and result]`
- `[FILER: shim non-finite test + suite name and result]`
- `[FILER: action stamp/omit tests + suite names and results]`
- `[FILER: tsc clean on SDK + server]`

## Risks

- Low risk. A lookup failure yields `undefined`, which is today's behavior.
- The action path has no project scope, so it falls back from agent to company.
- No migration. No schema change beyond one optional field.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- [FILER: provider + exact model ID, context window, reasoning/tool-use details]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
```

---

## D2 — ISSUE: run-scoped model decision hook (issue-first, then #dev)

- Target: new issue (`https://github.com/paperclipai/paperclip/issues/new/choose` → feature request)

Title: `Run-scoped model decision hook so a router plugin can choose the run model`

Body:

```md
**Problem / motivation**
Heartbeat merges operator overrides, then starts agents on the static default
model. Nothing asks the router which model a run should use. Router
cost and capability decisions never reach the run.

**Proposed solution**
Add a synchronous `onResolveRunModel` hook with a `run.model.resolve`
capability (one holder per company) before the adapter-config merge.
Gate it behind an experimental flag that defaults to off: flag-off means
advisory and record-only. When the flag is on and no decision arrives,
park the run in a `model_decision_pending` retry lane instead of silently
falling back to the default model.

**Alternatives considered**
Silent fallback to the default model when the router gives no answer.
Ruled out: a silent fallback hides router outages and defeats router control.

**Roadmap alignment**
Checked ROADMAP.md: Multi-Model and Multi-Harness Teams covers per-agent
model choice, but no entry covers a run-scoped router hook. No duplicate
found (searched `onResolveRunModel`, `model_decision_pending`,
`requireRunModelDecision` — zero hits).

**Request**
Maintainer direction in `#dev` before any PR: is this hook shape
acceptable, and what must the parking policy look like?
```

---

## D3 — PR: redaction affix bound

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/redaction-affix-bound`
- Title: `fix(redaction): bound secret field-name affixes to stop quadratic backtracking`

Body:

```md
<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The server redaction module masks secrets in event payloads and diagnostic text
> - The secret field-name pattern uses unbounded affixes around the keyword core
> - Unbounded affixes backtrack quadratically on long non-secret runs
> - A bound keeps the scan linear with no masking change on real names
> - This pull request bounds those affixes and adds regression tests
> - The benefit is long non-secret payloads no longer stall redaction

## Linked Issues or Issue Description

No existing upstream issue describes this bug, so it is described here.
No duplicate PR found (searched open upstream PRs for "redaction" at
draft time; matches are unrelated). Re-search exact title at filing time.

**What happened?**
`SECRET_FIELD_NAME_PATTERN` affixes were unbounded `*`. A long non-secret
run (for example a 50k-char dotted string) took seconds in the redaction
scan instead of milliseconds.

**Expected behavior**
The scan runs in linear time. Real secret keys stay masked, including
64-char affixes around the keyword core.

**Steps to reproduce**
Feed `sig.` + 50k `a` chars through `redactSensitiveText` with the
unbounded pattern. Observe multi-second time. Repeat with the bound.
Observe milliseconds and unchanged output.

**Paperclip version or commit**
`[FILER: master SHA at branch time]`

**Deployment mode**
Self-hosted server.

## What Changed

- Changed `*` to `{0,64}` on the affixes in `SECRET_FIELD_NAME_PATTERN`,
  with a comment that states why and which derived regexes the bound limits.
- Added two regression tests: linear time (50k/12k inputs that carry `.`
  so the JSON path actually runs — the first test version without them
  passed on the unbounded base, so it was fixed) and masking (real keys
  still masked, including 64-char affixes).

## Verification

- `[FILER: redaction suite result, e.g. 29 passed]`
- Reverted-pattern check: the linear-time test fails on the unbounded base
  (measured ~7145 ms against a 1000 ms limit) and passes with the bound.
- Synthetic timing: 20k-char key regex ~589 ms → ~5.9 ms; JSON path
  ~557.5 ms → ~6.0 ms; no output change on non-secret input.

## Risks

- Low risk. Only the backtracking window changes. Unanchored object keys
  still match on the keyword core at any length.
- The anchored flag regex and the JSON suffix window no longer mask names
  with more than 64 affix chars past the keyword. Real field names are
  far shorter.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- [FILER: provider + exact model ID, context window, reasoning/tool-use details]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
```

---

## D4 — PR: issue PATCH redacted-env restore

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/issue-patch-redacted-env-restore`
- Title: `fix(issues): restore redacted env placeholders on override PATCH`

Body:

```md
<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - Issues can pin assignee adapter config overrides, including adapter env
> - Agent and issue reads redact every plain env value to a placeholder
> - The agent update path restores those placeholders, but the issue PATCH route does not
> - A client that copies a redacted read into an issue pin persists the placeholder as the real value
> - The read-back hides the damage because reads redact too
> - With per-key override merge, the persisted placeholder shadows the agent's real value
> - This pull request restores display-only placeholders on issue PATCH
> - The benefit is a GET-then-PATCH round trip can no longer corrupt env values

## Linked Issues or Issue Description

No open upstream issue describes this bug, so it is described here.
Related: a prior fork-side attempt at the same fix was closed unmerged
without review; this PR carries that hunk forward. No duplicate upstream
PR found. Re-search exact title at filing time.

**What happened?**
Pin an issue override env key. GET the issue. PATCH the same overrides
back. The stored value is now the literal placeholder string.

**Expected behavior**
A PATCH that echoes back a redacted plain env binding keeps the stored
value for that key.

**Steps to reproduce**
1. Pin an issue override env key (for example `PATH`).
2. GET the issue (value reads back redacted).
3. PATCH the same `assigneeAdapterOverrides` back unchanged.
4. Read the stored value: it is the placeholder, not the original.

**Paperclip version or commit**
`[FILER: master SHA at branch time]`

**Deployment mode**
Self-hosted server.

## What Changed

- Added `restoreRedactedPlainEnvBindings(requestedEnv, sources)` in
  `server/src/redaction.ts`. It restores a redacted plain binding from the
  first source that holds the key. Other values pass through untouched.
- Called it in the issue PATCH route: stored issue override env first,
  then the assignee agent's stored env. The agent lookup has a
  same-company guard and runs only when a placeholder is present.
- Added 3 regression tests: stored-override restore, assignee-agent
  fallback, genuine-value passthrough.

## Verification

- `[FILER: issue-agent-mutation-ownership-routes suite result, e.g. 124/124]`
- Mutation check: with the route reset to master, the two restore tests
  fail and the passthrough test passes. The fix is then restored.

## Risks

- Low risk. The restore runs only when the requested override env holds a
  redacted plain binding. Genuine values and keys with no stored value
  pass through unchanged. No schema change. No migration.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- [FILER: provider + exact model ID, context window, reasoning/tool-use details]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
```

---

## D5 — PR: exit-143 cleanup forgiveness (refs #4307)

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/cleanup-sigterm-success`
- Title: `fix(heartbeat): keep cleanup SIGTERM from failing successful runs`

Body: port `docs/operator/tog-13327/PR_BODY.md` verbatim onto upstream
master (replace `Fork line at e60553d3` with the upstream master SHA and
`The adapter on this line` with the equivalent upstream adapter behavior;
keep `Related upstream discussion: paperclipai/paperclip#4307` and add:
`Upstream PR #4335 attempted an adapter+heartbeat fix for #4307 and was
closed unmerged; this PR fixes the heartbeat seam only, so it composes
with — rather than duplicates — that attempt`).
Checklist CI/Greptile boxes stay unchecked until the upstream PR runs them.

---

## D6 — ISSUE (upstream record): router run-end reap via `agent.run.finished`

- Target: new issue (`https://github.com/paperclipai/paperclip/issues/new/choose` → feature request)

Title: `Reaping plugin async work on agent.run.finished instead of host-side calls`

Body:

```md
**Problem / motivation**
A downstream fork keeps an interim host-side block in `heartbeat.ts` that
calls one plugin key's `cancel-run-invocations` action at terminal run
status, so orphaned async invocations do not outlive their run. That wiring
is instance-specific code in the control plane. The thin-core direction
says it belongs in the plugin, not the host.

**Proposed solution**
The plugin-native pattern: the router plugin subscribes to
`agent.run.finished` and cancels its own run invocations there, with no
host change. The host block is then deleted.

**Alternatives considered**
Keeping the host-side call. Ruled out: it hard-codes one plugin key in
`heartbeat.ts` and every other plugin would need the same treatment.

**Roadmap alignment**
Plugin-system milestone (optional capabilities belong in plugins, not
core). `agent.run.finished` is already a first-class plugin event
(PLUGIN_SPEC.md event list, SDK README event table).

**Request**
Please confirm this pattern is the intended one, and confirm the event
payload carries everything a plugin needs to identify its own
run-scoped invocations.
```

---

## D7 — PR: bound launch envs + continuation history (supersedes #14092)

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/spawn-e2big-launch-bounds`
- Title: `fix: bound launch environments and continuation history against E2BIG`

Body: port upstream PR #14092's body verbatim onto current master (that
PR is closed unmerged; this supersedes it — say so in Linked Issues with
`Supersedes #14092` plus `Refs #13891, #13793`). Code: rebase the four
fork cherry-pick hunks (launch-env prune, review fixes, reserved-arg
budget, exact quoting + receipts cap) onto master. Honest re-verification
required: the redaction of the #14092 body claims it carries ("322
tests", typecheck) must be re-run on the new head — do not copy numbers
without re-running.
Checklist CI/Greptile boxes stay unchecked until the upstream PR runs them.

---

## D8 — PR: strip server secrets from agent child env

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/child-env-secret-strip`
- Title: `fix(adapter-utils): strip server secrets from agent child environments`

Body:

```md
<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The server spawns agent child processes with an inherited environment
> - That environment can carry server credentials (database URLs, session secrets, provider keys)
> - A child that inherits a database URL can damage the server schema by mistake
> - Runs should receive credentials only through explicit per-run secret bindings
> - This pull request extends the inherited-env sanitizer with a fail-closed denylist
> - The benefit is agent children never inherit server credentials

## Linked Issues or Issue Description

No existing upstream issue describes this gap, so it is described here.
`sanitizeInheritedPaperclipEnv` exists upstream but only filters
`PAPERCLIP_*` keys. No duplicate PR found. Re-search exact title at filing time.

**What happened?**
A server-style environment inherited `DATABASE_URL` into an agent child,
and a schema migration wiped the production schema as a superuser.

**Expected behavior**
Agent children inherit no server credentials. Bound runs still receive
their keys through explicit per-run env, which merges after the sanitizer.

**Steps to reproduce**
Pass a server-style env (database URL, session secret, provider key)
through `sanitizeInheritedPaperclipEnv`. Observe the secrets surviving
upstream, and being stripped with this fix.

**Paperclip version or commit**
`[FILER: master SHA at branch time]`

**Deployment mode**
Self-hosted server.

## What Changed

- Added a fail-closed denylist to `sanitizeInheritedPaperclipEnv`:
  exact keys (database URLs, session secret, provider keys), `DATABASE_` /
  `POSTGRES_` / `PG` prefixes, and the `*_API_KEY` suffix.
- Added regression tests: database vars, session secret, provider keys,
  fail-closed future families, allowlist preservation, and a server-style
  env sweep.

## Verification

- `[FILER: server-utils-env suite result]`
- `[FILER: tsc clean on adapter-utils]`

## Risks

- Low risk. Stripping happens before per-run bindings merge, so a bound
  run cannot be starved — only the implicit inheritance path is removed.
- A future non-secret `*_API_KEY` var would be stripped too; that matches
  the naming convention and is configuration-recoverable.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- [FILER: provider + exact model ID, context window, reasoning/tool-use details]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
```

---

## D9 — PR: tool-gateway MCP result shaping

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/tool-gateway-result-shape`
- Title: `fix(tool-gateway): shape tools/call results to the MCP contract`

Body:

```md
<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The tool gateway serves MCP `tools/call` results to strict clients
> - The gateway emits `structuredContent: null` for results that carry none
> - Strict MCP clients reject a null `structuredContent` key
> - Stored failures replayed without their error flag lose the failure signal
> - This pull request omits null `structuredContent` and carries `isError` on replay
> - The benefit is gateway results validate against the MCP contract

## Linked Issues or Issue Description

No existing upstream issue describes this gap, so it is described here.
Upstream still emits `structuredContent: result` / `?? null` on the route
and service paths. No duplicate PR found. Re-search exact title at filing time.

**What happened?**
A plugin content-only result came back with `structuredContent: null`,
which strict MCP clients reject. A replayed failed invocation came back
with `isError: false`.

**Expected behavior**
Results carry `structuredContent` only when it is a plain object, and
replays carry the stored failure flag.

**Steps to reproduce**
Call a plugin tool that returns content without structured data.
Validate the result against `CallToolResultSchema`. Observe the failure
upstream, and the pass with this fix. Mark a stored invocation failed and
replay it. Observe `isError` upstream vs fixed.

**Paperclip version or commit**
`[FILER: master SHA at branch time]`

**Deployment mode**
Self-hosted server.

## What Changed

- Added `toMcpCallResult`: unwraps the connected-MCP and plugin
  dispatcher envelopes, omits `structuredContent` unless it is a plain
  object, and carries `isError` from outer and shaped records.
- Stopped emitting `structuredContent: null` on the route and service paths.
- `storedInvocationResult` now parses the stored summary and stamps
  `isError: true` on failed rows, with a message-shaped fallback.
- Replays return the stored result instead of the raw summary.
- Added schema-validated regression tests (content-only shape, object /
  null / array shaping, failed replay).

## Verification

- `[FILER: tool-gateway suite result]`
- `[FILER: tsc clean on server]`

## Risks

- Low risk. Only result shaping changes; no access, routing, or storage change.
- Envelope detection requires both envelope keys, so built-in payloads
  that happen to carry `data` or `result` are never mis-unwrapped.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- [FILER: provider + exact model ID, context window, reasoning/tool-use details]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
```

---

## D10 — PR: EPIPE-tolerant child stdin

- Target: open PR against `paperclipai/paperclip` `master`
- Branch: `fix/child-stdin-epipe`
- Title: `fix(server): survive closed child stdin without crashing controller`

Body:

```md
<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The controller spawns agent child processes and writes deferred stdin payloads
> - A child can exit or close its stdin before the deferred write lands
> - The write then hits a broken pipe, and Node emits EPIPE asynchronously
> - With no listener that surfaces as an uncaught exception and kills the whole controller
> - Every in-flight run dies with it, not just the one run
> - This pull request adds a broken-pipe listener and guards the sync write path
> - The benefit is one closed pipe can no longer take down the controller

## Linked Issues or Issue Description

No existing upstream issue describes this gap, so it is described here.
Upstream has an EPIPE guard only in `plugin-worker-manager.ts`
(the plugin-worker path); `runChildProcess` in adapter-utils has none
(verified at master `569c7203`). No duplicate PR found. Re-search exact
title at filing time.

**What happened?**
A deferred stdin payload hit a child pipe the child had already closed.
The unhandled stream error crashed the whole controller process.

**Expected behavior**
The run settles with the child's real exit code. The failure stays
contained to that run. Other stream errors stay visible through the
error log.

**Steps to reproduce**
Spawn a child that exits at once while the spawn-persist stays slow,
with a stdin payload. Observe the controller crash upstream, and a
normal settle with this fix. Repeat with a live child that destroys its
own stdin read end.

**Paperclip version or commit**
`[FILER: master SHA at branch time]`

**Deployment mode**
Self-hosted server.

## What Changed

- Registered a stdin `error` listener before the deferred write: it
  swallows only `EPIPE` / `ECONNRESET` and reports other stream failures
  through the error log.
- Guarded the sync write/end path with try/catch so a sync failure
  cannot reject the unhandled persist chain.
- Added 4 regression tests on the real spawn path: normal input,
  exited-before-persist, async EPIPE from a live readerless child, and
  the combined slow-persist shape.

## Verification

- `[FILER: server-utils suite result, e.g. runChildProcess tests]`
- `[FILER: tsc clean on adapter-utils]`
- Before/after: the new tests crash the host process on the unguarded
  base and pass with the fix (re-verify at filing time on current master).

## Risks

- Low risk. Only broken-pipe codes are swallowed; every other stream
  error is still logged. The guards read the same child state as before.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- [FILER: provider + exact model ID, context window, reasoning/tool-use details]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
```

