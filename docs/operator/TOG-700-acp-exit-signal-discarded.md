# DRAFT — not filed

Upstream defect report against a Paperclip-consumed vendor package. Held here
per the same convention as `TOG-687-claude-local-effort-default.md` in this
directory (agents cannot commit to `/app`, no push credential to any real
upstream repo — same gap as TOG-739). Per the owner's 2026-08-30 standing
instruction, nothing here modifies live Paperclip source; this is carried
upstream as a product-issue report only, same disposition as TOG-687.

Written for **TOG-700**, split from TOG-692 items 3 and 4.

---

## Item 3 (confirmed, root cause identified): the ACP backend discards a signal-bearing process-exit message before it reaches Paperclip

**Component:** `@agentclientprotocol/claude-agent-acp@0.63.0`, `dist/acp-agent.js`
(third-party npm package — **not** Paperclip's own `acpx-engine`)
**Class:** diagnostic-information loss on a fatal path
**Severity:** medium — does not affect run correctness, but destroys the one
signal (SIGABRT vs SIGKILL, i.e. in-process abort vs cgroup OOM-kill) an
operator needs to triage a process-death without reading raw stderr

### The chain, traced end to end

1. `@anthropic-ai/claude-agent-sdk@0.3.220`'s `ProcessTransport.getProcessExitError(exitCode, signal)`
   correctly builds a precise message, e.g.:
   ```
   Error(`Claude Code process terminated by signal ${signal}${this.formatStderrTail()}`)
   ```
   confirmed verbatim in `sdk.mjs`. This precision does reach `run-stderr/` logs.

2. `claude-agent-acp`'s session-turn catch block (`acp-agent.js`, ~line
   2840-2870) receives that error, pattern-matches its message against a
   fixed set of substrings (`"ProcessTransport"`, `"terminated process"`,
   `"process exited with"`, `"process terminated by signal"`, `"Failed to
   write to process stdin"`) to classify it as a process death, logs the
   **full** message via `this.logger.error(...)` — then discards it and
   throws a hardcoded generic replacement instead:
   ```js
   const SESSION_ENDED_MESSAGE = "The Claude Agent session has ended. Please start a new session.";
   ...
   failAllTurns(RequestError.internalError(undefined,
     "The Claude Agent process exited unexpectedly. Please start a new session."));
   ```
   This is where the signal detail is actually lost — one layer *below*
   Paperclip's own code, inside the vendored ACP backend package.

3. Paperclip's own `acpx-engine/execute.ts` does **not** discard anything
   further. `resultErrorMessage()` (line ~2443) relays `result.error.message`
   verbatim, and that value flows unmodified into `heartbeat.ts`'s
   `finalizeAgentStatus(agentId, outcome, adapterResult.errorMessage, ...)`
   (called at every one of its 8 call sites the same way), which writes it
   straight into `agents.errorReason` via `truncateAgentErrorReason()`. By
   the time it reaches Paperclip, the generic string is already all that's
   left to relay — first-party code is a faithful pass-through, not the
   source of the loss.

**Correction to the original framing:** TOG-692/TOG-700 described this as
"the SDK captures the signal but Paperclip discards it." That is not what the
source shows. The SDK's message is captured; the ACP *wrapper package*
(`claude-agent-acp`) discards it via a substring-classify-and-replace catch
block, before Paperclip's own executor ever sees it. Paperclip's ACP-lane
code has no visibility into the original message once that catch fires — it
cannot recover what was already thrown away one layer down.

### Suggested fix

The correct fix lives in `claude-agent-acp`'s catch block: keep the
`processDied` classification (useful — it's a real distinct failure mode
worth flagging), but preserve `message` as the thrown error's content (or
append it) instead of substituting the fully generic string. E.g.:
```js
failAllTurns(RequestError.internalError(undefined,
  `The Claude Agent process exited unexpectedly: ${message}`));
```
This is upstream-vendor code Paperclip does not own; a downstream patch
inside `acpx-engine/execute.ts` could in principle re-derive the signal from
raw stderr (which the SDK already tails into the message it throws, before
`claude-agent-acp` overwrites it) but that means re-parsing text Paperclip
never sees today — the SDK's structured message is destroyed before crossing
into anything Paperclip's own executor touches. The clean fix is upstream, in
`claude-agent-acp`.

---

## Item 4 (checked against live source, does NOT reproduce — stale claim)

TOG-700's description states `errorReason` is "sticky" — that it survives a
subsequent successful run and shows a stale failure to readers of a healthy,
recovered agent.

Read `finalizeAgentStatus()` in `server/src/services/heartbeat.ts`
(~line 12816-12873), the single function that ever sets `agents.errorReason`
after run completion:

```ts
errorReason: nextStatus === "error" ? truncateAgentErrorReason(failureReason) : null,
```

`nextStatus` is `"error"` only when the run outcome was a genuine failure
(not `succeeded`/`interrupted`/`cancelled`, and not a `failed` outcome with
`keepIdleOnFailure`) **and** no other run for the agent is still `running`.
Every other outcome — including every successful run after a prior failure —
sets `errorReason: null` unconditionally in the same UPDATE. All 8 call
sites of `finalizeAgentStatus` in `heartbeat.ts` route through this one
function; there is no second code path that writes `agents.errorReason`
without also clearing it on recovery. The other four writers of
`errorReason` in `server/src/services/agents.ts` (`pause`, `resume`,
`clearError`, `terminate`) all set it to `null` as well — none of them ever
*sets* a reason, so they cannot be the source of stickiness either.

Grepped `errorReason` across `server/src/services/*.ts`: every non-test
writer is accounted for above; none leaves a stale value in place after a
successful run.

**Conclusion:** as of this deployment's source, Item 4 does not reproduce.
Either it described an earlier version's behavior that has since been fixed,
or the original TOG-688 observation had a different cause (e.g. reading a
cached/stale API response, or a race where the UI queried between the failed
run's write and the next run's clear) rather than a genuine failure of this
clearing logic. Recommend **not** filing Item 4 upstream as written; if
TOG-688's premise needs revisiting, it should be re-verified against a fresh
live repro rather than assumed from the original description.

### Why this matters for TOG-688

If TOG-688 (or any other issue) relied on "an agent showing an error reason
must currently be failing," this analysis says that inference is safe as
implemented: `errorReason` is only ever non-null when the agent's live
`status` is `"error"`, and both fields are written in the same UPDATE
statement. A reader that checks `status === "error"` before trusting
`errorReason` will never see a stale reason attached to a healthy agent.
