# 0009 — Same wire, different multiplexer: CLIProxy carries Claude

> **Superseded by compatible-upstream v1 (TOG-530/TOG-532).** This record is retained as historical context only; its deployment-specific policy is not active product behavior.


Status: proposed — owner ruling required (TOG-359 is an owner gate)
Date: 2026-08-24
Extends [0008](0008-reach-precedes-selection.md), which parked Plano and named
`prompt_caching` with session affinity as the one capability nothing else on the
board covered. This record establishes that OmniRoute's native OAuth path does
not cover it either, and that CLIProxy does.

## Context

The owner set a gate:

> *"Before we consider using omniroute's native oauth providers I would need to
> see research on exactly how it interacts with the upstream provider and what
> the differences are vs cliproxy and teamclaude. If they work the same, using
> omniroute's native oauth could be what we use."*

Two operator passes on TOG-359 established the happy path and the failure path.

**The happy path is genuinely the same in all three.** Same endpoint
(`api.anthropic.com/v1/messages`), same credential class (Max OAuth), same
Claude Code header impersonation. OmniRoute's native `claude` provider carries
`authType:"oauth"`, refreshes at `/v1/oauth/token`, and calls
`getClaudeCliHeaders()`. Read at the wire, the owner's premise holds.

**The failure path already differs, measured.** With one account 5h-exhausted
and the other rate-limited, the identical request through teamclaude `:3456`
could not complete in 45 s — its log shows `Rate-limit 429 … waiting 60s,
retrying same account (no switch)` on repeat. CLIProxy `:8317` answered
immediately on a healthy lane with the full Anthropic envelope. That alone
retires teamclaude as a candidate.

**And OmniRoute's Claude path today is not a subscription at all.** A
`claude-sonnet-5` request to `:20129` returned an OpenRouter generation id and
incremented OpenRouter's lifetime counter. As configured, consolidating on
OmniRoute would put 100% of Claude traffic on pay-as-you-go and strand both Max
subscriptions — the inverse of the requirement.

So the gate reduces to one live question: **if we registered OmniRoute's native
`claude` OAuth provider, would it work the same?** Three things had to be proven
— prompt caching end-to-end, two-account level convergence, and quota telemetry.
None could be tested, because the path being tested does not exist yet.

They can, however, be *settled against the contract*. This record uses the
method that resolved TOG-188: OmniRoute serves its full OpenAPI spec
unauthenticated at `:20128/openapi.yaml`, and for existence questions the
**write-side** schema is authoritative — you cannot configure what there is no
field to set.

## Decision

**They do not work the same. The wire is identical; the multiplexer is not.
Claude traffic goes through CLIProxy.**

### The finding: OmniRoute has no session affinity, and cannot be given one

`ComboCreate` — the only way to put two accounts behind one model — is, in full:

```yaml
required: [name, model]
strategy:  # closed enum, default priority
  priority · weighted · round-robin · context-relay · fill-first · p2c · random
  least-used · cost-optimized · reset-aware · strict-random · auto · lkgp · context-optimized
nodes: [{ connectionId, weight, priority }]
```

`affinity` and `sticky` occur **zero times in all 6,690 lines**. Every `session`
hit in the spec is a traffic-inspector recording, a management auth cookie, or
`/api/sessions` (live runtime connections). Combo routing is per **request**,
across `nodes`, and there is no field on the write side to scope a conversation
to a connection. This is not "undocumented" — it is unsettable through every
supported surface.

### Why that costs money: the two requirements are in direct tension

Anthropic's prompt cache is scoped to the credential. Two Max accounts are two
organisations, so a request served by account B **cannot read a cache entry
created by account A** — the switch is a cold cache, and TOG-164 measured a
destroyed cache at **30.8×**. CLIProxy's own design corroborates the mechanism:
`session-affinity 24h` exists precisely because cross-account cache reads do not
work.

That splits OmniRoute's strategy enum into two halves, and we need both:

- **Level convergence** (requirement 2) needs a distributing strategy —
  `round-robin`, `least-used`, `weighted`, `p2c`. All route per request. On
  multi-turn agent traffic a conversation bounces between accounts and re-pays
  the full accumulated context on every bounce.
- **Cache preservation** (requirement 1) needs a pinning strategy — `priority`,
  `fill-first`, `lkgp`. These hold one connection until it fails, reproducing
  exactly the teamclaude defect `distributeSessions` was built to fix: one
  account structurally guaranteed to expire mostly unused.

**No value of `strategy` satisfies both, because the choice is made at the wrong
granularity.** CLIProxy resolves it by distributing at *session* granularity and
pinning *within* a session — `round-robin` plus `session-affinity 24h`. That is
the whole trick, and OmniRoute's contract has no equivalent.

Note that per-issue model pinning — this repository's standing recommendation
from TOG-188 — does **not** rescue this. Pinning the model does not pin the
account; a combo still rotates connections per request inside a single issue.

### Quota: a declared plan is not the provider's answer

OmniRoute's quota telemetry exists, but it is the wrong kind. `/api/quota/plans`
returns *"resolved provider plans (catalog + manual overrides)"* with
`source = auto | manual`, and `/api/quota/preview` takes `estimatedTokens`,
`estimatedUsd`, `estimatedRequests` and returns allow/block. That is **local
counting against a declared allowance**, not a read of Anthropic's actual
per-account state. teamclaude's `/teamclaude/status` and `cliproxy_quota.py`
both fetch Anthropic `/api/oauth/usage` — ground truth.

The operator's measurement shows why the distinction bites: `pisnrzrs` was being
429'd while reporting `unified5h 0.44`. A model that believes a catalogue number
would have been further from the truth still. OmniRoute does expose
`/api/rate-limits` ("per-account rate limit status"), but that is *reactive* —
it learns after being refused. Useful for failover, not for a brake.

This one is not fatal on its own: `cliproxy_quota.py` reads Anthropic directly
and works regardless of which proxy carries traffic. It is recorded so it is
known rather than assumed.

### Where OmniRoute is genuinely strong, and it does not change the answer

OmniRoute has real resilience primitives that teamclaude lacks entirely:
`/api/resilience` (request queue, connection cooldown, provider breaker, wait
settings), `/api/resilience/reset`, and circuit-breaker state on
`/api/monitoring/health`. On failure behaviour OmniRoute is structurally the
opposite of teamclaude's sleep-and-retry-the-same-account. This is a point in
its favour — it is simply not the point under contention, and it applies to
OmniRoute-in-front-of-CLIProxy just as much as to native OAuth.

### The extra hop is the vendor's supported topology, not a workaround

The remaining objection to CLIProxy was one more process in the path. OmniRoute
treats CLIProxyAPI as a **first-class embedded service** with a full supervised
lifecycle: `/api/services/cliproxy/` `install` · `start` · `stop` · `restart` ·
`update` · `status` · `auto-start` (*"starts automatically on the next OmniRoute
boot"*), alongside 9Router. The hop is a subprocess OmniRoute installs from npm
and supervises — not an independent service we bolted on. Meanwhile "five OAuth
flows re-authorised inside OmniRoute" duplicates a credential store that already
holds all seven logins.

## Consequences

**TOG-352 proceeds unchanged and is not gated on this.** Registering CLIProxy in
OmniRoute via the native `cliproxyapi` provider is the owner's stated direction
and is now also the researched recommendation. Reach still precedes selection
([0008](0008-reach-precedes-selection.md)).

**"Retire both" becomes "retire teamclaude, keep CLIProxy."** teamclaude is
measured as the weakest path on the dimension that matters most under
contention, and it holds no capability the other two lack.

**OmniRoute native `claude` OAuth is not adopted as the Claude path.** It
remains correct for genuinely single-account providers, where nothing rotates
and the tension above never arises. It is wrong for our two Max accounts.

**Still unproven, and unprovable until a subscription path exists in OmniRoute:**
prompt caching end-to-end on that path. This record does not claim OmniRoute
strips `cache_control` — the operator read the running build and found it
preserves the header and injects `ephemeral ttl:"1h"`. The risk identified here
is not header stripping; it is that OmniRoute's own rotation destroys the cache
that the header would otherwise have earned. Spec silence on `cache_read` /
`cache_creation` means OmniRoute does not *model* the prompt cache, which is
consistent with transparent passthrough and is not evidence against it.

**Cheapest empirical check, for the operator, if this decision is contested.**
It needs no OmniRoute change and can run today through CLIProxy, which already
has both accounts and returns full cache accounting: send a large-prefix request
pinned to account A, repeat it pinned to account B, and read
`cache_read_input_tokens` on the second. The mechanism above predicts `0`. If it
comes back non-zero, cross-account cache sharing exists, the tension dissolves,
and this record should be reopened.

**Re-open trigger.** OmniRoute native OAuth returns to the table if the contract
gains a conversation-scoped affinity field on combos, or if we drop to a single
Max account. Absent one of those, adding accounts to an OmniRoute combo makes
caching worse the more accounts we add.

## What this record does not decide

OmniRoute flags its own `claude` provider `subscriptionRisk: true` /
`riskNoticeVariant: "oauth"`. That flag is a terms-of-service posture question,
it applies **equally to all three paths** — every one of them drives a
subscription credential through an automated harness — and it is the owner's
call, not an engineering one. Nothing in this record engineers around it, and
per the operator's scope note, header-level work aimed at making a proxy
indistinguishable from a vanilla CLI is deliberately out of scope.

### Provenance

Contract claims are from OmniRoute OpenAPI `3.1.0`, `info.version: 3.8.35`,
6,690 lines / 201 paths, served unauthenticated at `:20128/openapi.yaml`.
Measurements are the operator's, recorded on TOG-359 on 2026-08-24. The 30.8×
switch cost is TOG-164. The unauthenticated-spec method is TOG-188.
