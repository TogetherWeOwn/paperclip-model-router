# TOG-13110: per-conversation prompt_cache_key for Meta/Muse in CLIProxy

**Result:** a one-commit patch against the tog.3 tree (upstream `router-for-me/CLIProxyAPI`
`v8.0.12` + TOG-3403 alias fix + TOG-12934 reasoning-replay series) that stamps a stable
**per-conversation** `prompt_cache_key` on every Meta Responses request, so Meta routes each
conversation to backends that already hold its prefix. Measured baseline to beat: ~87% Keeper
cache-hit rate (`cache_read_tokens` / `input_tokens`).

**DO NOT DEPLOY until the Muse reasoning-replay canary (TOG-13077) has concluded.** A global
CLIProxy change mid-canary would shift Muse cache metrics in both arms. This card delivers a
reviewed patch + build recipe only; the operator swaps the image later.

## Research (all from Meta primary sources, 2026-10-03)

- **Responses API accepts `prompt_cache_key`.** The prompt-caching guide states it "is accepted
  on both Responses and Chat Completions, and replaces the deprecated `user` field":
  https://dev.meta.ai/docs/prompt-caching ("Group similar requests with a cache key").
- **No per-key throughput limit documented.** Rate limits are per-team (Standard: 3,000 RPM /
  4M TPM), not per key: https://dev.meta.ai/docs/pricing-rate-limits. The key itself carries
  no charge; cached input bills at $0.15 vs $1.25 per 1M tokens (standard tier, ~8x cheaper),
  so each recovered miss is worth roughly $1.10 per 1M tokens.
- **One honest caveat, and why per-conversation is still right.** Meta's guide warns "Don't
  over-partition: unique keys per user or per session lower hit rates because each key routes
  independently" and suggests naming an app/use case. That advice fits fleets sharing one
  static prefix. Muse traffic is the opposite shape: every conversation carries a growing,
  unique history (the bulk of its tokens), the baseline is already 87% (automatic prefix
  caching captures the shared part), and account rotation changes credentials every turn, so
  auth cannot be the affinity signal. The key targets the remaining scatter misses. A static
  fleet-wide key stays WRONG: it would pin all Muse traffic to the same backends (hot spot).
- **`prompt_cache_retention` stays stripped.** It is a server-side eviction hint (`in_memory`
  default / `"24h"` extended), orthogonal to the routing key. Keeping today's strip means
  zero behavior change; `"24h"` is a separate cost/retention decision for its own card.

## What changed

Patch: `docs/operator/tog-13110/cliproxy-v8.0.12/0001-feat-meta-stamp-per-conversation-*.patch`
(`02dcbdf9…26065e`), one commit, 3 files, +351/−0:

- `internal/runtime/executor/meta_prompt_cache_key.go` (new): `resolveMetaPromptCacheKey`.
  Precedence mirrors the Codex/OpenAI-compat derivation: (1) an explicit client key wins, read
  from `req.Payload`, `opts.OriginalRequest`, or the translated body (so an operator
  payload-config key is preserved); (2) otherwise a UUIDv5 over the conversation session
  identity — execution session first, then derived identity, then request-context session —
  namespaced `cli-proxy-api:meta:prompt-cache + model`, so one session on two models does not
  falsely share a key; (3) with no session identity **no key is set** — a credential-scoped
  (API-key hash) fallback would pin every conversation on that credential to the same
  backends, the hot spot this exists to avoid. No auth material enters the key, so per-turn
  account rotation keeps the same key.
- `internal/runtime/executor/meta_executor_execute.go` (+7): hook the resolver after
  payload-config (operator key preserved) and the `prompt_cache_retention` strip (documented
  why it stays), before the reasoning sanitizers so the retry-without-replay path keeps the
  key. Covers `Execute` and `ExecuteStream` (shared prepare path).
- `internal/runtime/executor/meta_prompt_cache_key_test.go` (new): 10 tests — same session
  → same UUID key; distinct sessions → distinct keys; model scoping; client key preserved
  from all three sources; blank client key falls back to session; no identity → no key;
  context-session fallback; execution-session precedence; full `Execute` wire test (stable
  key across two turns, retention still stripped); client-key end-to-end.

## What was verified

- `go build ./...`, `go vet`, `gofmt` clean on the touched package.
- New tests: 10/10 pass. Full `go test ./internal/runtime/executor/...` (executor + helps):
  all ok — Meta replay and alias behavior unchanged.
- Negative control: with the 7-line hook reverted, the wire test fails (no key on the wire);
  restored, it passes. The test guards the behavior, not the file's existence.
- Operator-side application: `git am` of exactly this patch onto pristine `190f6eb8`
  (replay-series tip) applies clean, builds, and passes both executor suites.
- NOT done (blocked by owner constraint): no stage swap, no live Meta probe, no Keeper
  before/after numbers. The wire shape is translator output (`input` array, `store:false`);
  Meta's tolerant reader is assumed, not proven — the post-canary probe below must confirm.

## Measurement plan (post-canary, operator)

1. **Acceptance probe:** one Responses call with a `prompt_cache_key` against live Meta;
   200 + echo of the field (or documented ignore) proves acceptance. If Meta ever rejects
   unknown fields, the whole change is a no-op risk — confirm first, then roll.
2. **Before/after (same 7-day window shape):** Keeper cache-hit ratio per Muse model,
   p50/p95 turn latency, Muse quota burn. Expect small but positive hit-rate movement on top
   of 87%, and no latency/429 regression (watch for hot-spotting if a session fan-out bug
   ever collapsed keys — the distinct-sessions test pins this).
3. Idle TTL is 12–25 min (community-measured); `"24h"` retention stays a separate decision.

## Build / swap / rollback (operator, after canary + review)

```
cd ~/build/cliproxy-patch
git status --short            # must be clean, on the tog.3 tip
git am docs-operator-path/0001-feat-meta-stamp-per-conversation-*.patch
go build ./... && go test ./internal/runtime/executor/... -count=1
# tag/build per the tog.3 recipe, e.g. cliproxy-local:v8.0.12-tog.4-cachekey-<shortsha>
swap-image.sh <new-image>     # existing runbook; auto-rollback armed
```

Rollback: `swap-image.sh` back to the tog.3 image
(`cliproxy-local:v8.0.12-tog.3-musereplay-102e4e5b2ea6`). The change is additive (a new
request field); rollback is a clean image swap with no config migration.

Upstream after audits → Steward → CEO, alongside the other CLIProxy fixes (no internal IDs
in the upstream text; the commit message is already upstream-clean).
