# TOG-12934: account-safe replay of Muse reasoning in CLIProxy

**Result:** a four-commit patch against upstream `router-for-me/CLIProxyAPI` `v8.0.12` that lets Muse see its own earlier reasoning across tool turns without the cross-account 400 that forced the naive pass-through (tog.2) to be rolled back. The feature is behind `upstream.meta.reasoning-replay.enabled`, default **off**, so swapping the image changes nothing until the switch is flipped.

It has been verified against a fake Meta upstream that enforces account binding. It has **not** been run against live Meta: agent containers hold no Meta credentials and none were borrowed. The operator stage run and the 48 h canary below are the live proof.

## Why tog.2 failed, and what this does instead

Meta binds each reasoning `encrypted_content` envelope to the account that issued it. Claude Code resends the whole history every turn, and that history mixes envelopes from every pool account that served an earlier turn. Forwarding it verbatim passes with one account and 400s ("reasoning encrypted_content was not issued to this caller") with several.

| Step | Behaviour |
| --- | --- |
| Response to client | Every reasoning envelope is wrapped `meta#<account-key>#<envelope>`: Anthropic thinking signature **and** Responses `encrypted_content`, streaming **and** non-streaming, SSE **and** plain-JSON upstream bodies. |
| Request from client | The Meta executor, which knows the selected credential, keeps an envelope only when its tag names that credential, and strips the tag. Another account's tag and every untagged (legacy) envelope are dropped. A dropped Claude-translated item disappears entirely, which is what happened to every envelope before. |
| Safety net | If Meta still answers "not issued to this caller" the request is retried **once** with every envelope removed (HTTP 4xx, and for non-streaming requests also an error event inside a 200 body). It is never retried twice. |
| Switch | `upstream.meta.reasoning-replay.enabled` (default false) and optional `models` patterns (case-insensitive, `*` wildcards, matched against the requested name including an `oauth.model-alias`, and the upstream model). |
| Rolled back | With the switch off, tagged envelopes from earlier turns are dropped like any other, so turning it off is safe at any time. |

`<account-key>` is the first 8 bytes of `sha256("cliproxy/meta-reasoning-account/v1\0" + auth.ID)` in hex. It is derived from the credential's identity, not from the short-lived API key, so token re-minting does not change it. A credential without an ID gets no key and is never replayed. If Meta binds envelopes more finely than the account (for example to the minted key), the safety net absorbs the difference and the `Meta rejected` log line counts it.

Other lanes are untouched: a tagged Muse signature is *foreign* to Claude, GPT, Gemini, Kimi, Grok and SWE exactly as the raw envelope was (pinned by `TestMetaTagIsForeignToEveryOtherLane`), and the Claude→Codex translator keeps a tagged signature only for `muse*` targets.

## Artifact

Base: upstream tag `v8.0.12` (`2044a01f`). The live build is `v8.0.12` plus the TOG-3403 alias fix, which touches `claude_executor_request.go`, `helps/claude_mcp_alias.go` and their tests; none of those are touched here, so the series applies on top of it. If `~/build/cliproxy-patch` still carries the tog.2 pass-through commit (`5c5e1eb`), revert it first: this series replaces it.

Patches are in `docs/operator/tog-12934/cliproxy-v8.0.12/`, also at `/paperclip/handoff/tog12934/` on the host:

```
641b3da27052adf1a0705ce97971b9310b5795ce08da0b008c4a555ea3e677f7  0001-feat-signature-add-account-provenance-tag-for-Muse-r.patch
cc13a783903fe9ab9496512c76f58f88387b9a7d65c8e3fa143501ce6e2616b3  0002-feat-config-add-upstream.meta.reasoning-replay-switc.patch
a39b1487579daa6312e63fb534e5d45dcf120ac2b9e618740b2c36e726a37d4b  0003-feat-translator-keep-Muse-tagged-reasoning-when-conv.patch
126eb1e67bd44029a0a0ae33a7ab843fb6284e4d3966bde2659815019a81bd6d  0004-feat-meta-account-safe-replay-of-Muse-reasoning-acro.patch
```

```
cd ~/build/cliproxy-patch
git status --short            # must be clean; revert 5c5e1eb first if it is present
git am docs/.../0001-*.patch docs/.../0002-*.patch docs/.../0003-*.patch docs/.../0004-*.patch
go build ./... && go test ./internal/signature ./internal/config ./internal/translator/codex/claude ./internal/runtime/executor -count=1
```

15 files, +1735/−61, of which about 1150 lines are tests. Each commit builds and passes the affected packages on its own.

## What was verified

All run against a clean `v8.0.12` + `git am` of exactly these patches (the resulting tree is byte-identical to the working tree):

- `go build ./...` and **full `go test ./...`: 100 packages ok, exit 0**.
- 38 executor test cases and subtests (`MetaReasoning`) plus signature, config and translator tests. The ones that would have caught tog.2:
  - `TestMetaReasoningReplay_LongConversationAcrossAccounts`: a fake Meta upstream rejects any envelope issued to a different account, behind a real `Manager` that rotates accounts every turn. 24 turns across 2, 3 and 4 accounts. Zero rejections, no retry, and each turn forwards **exactly** the envelopes the selected account issued earlier (the oracle is derived from what actually happened, and the test fails if the pool did not really switch accounts).
  - `TestMetaReasoningReplay_StreamingConversationAcrossAccounts`: same through `ExecuteStream`.
  - `TestMetaReasoningReplay_SingleAccountReplaysWholeHistory`: with one account every earlier envelope is replayed, which is the benefit the feature exists for.
  - `TestMetaReasoningReplay_CanaryAliasThroughManager`: an `oauth.model-alias` fork on the model list switches the feature on for the alias and leaves the control group's requests untouched.
- Mutation check on the executor tests: replay any tagged envelope regardless of account; replay untagged raw; do not strip the tag; skip tagging in the stream path, in the non-stream SSE path, or in the plain-JSON fallback; remove the retry; retry without having forwarded an envelope; retry more than once (this one is an endless loop in the streaming path); retry only HTTP rejections and not error events; leave a dropped item empty; ignore the disabled switch; ignore the model list or the alias; derive the account key from the rotating API key. Each is caught by at least one test. One mutant (forcing `enabled` after the model check) is equivalent and survives by construction.
- Operator tools in `docs/operator/tog-12934/tools/` have `--selftest`.

## Rollout

The switch is off by default, so the image swap itself is behaviour-neutral. Verify that first.

1. **Swap** with `ops/cliproxy/swap-image.sh` (auto-rollback), then run the existing single-account `muse_replay_probe.py` and `tools/muse_replay_multiaccount_probe.py --no-expect-tags`. Both must behave exactly as before the swap.
2. **Stage.** Add a canary alias so only requests addressed to it are affected, and hot-reload:

   ```yaml
   oauth:
     model-alias:
       meta:
         - name: "muse-spark-1.3"
           alias: "muse-canary"
           fork: true
   upstream:
     meta:
       reasoning-replay:
         enabled: true
         models: ["muse-canary"]
   ```

   Run `CLIPROXY_API_KEY=... tools/muse_replay_multiaccount_probe.py --base-url http://cliproxy:8317 --model muse-canary --turns 8`. It forces consecutive turns onto different accounts with a fresh session id per turn and passes only if no turn fails, every thinking signature is a `meta#` tag and at least two accounts served the loop. Then run `muse_replay_hit_rate.py` over the same log window: `retries_without_replay` should be 0 here, and `dropped_foreign` should be non-zero (the rotation is real).
3. **Canary, 48 h.** Pin 2–3 Muse agents to `muse-canary` and keep same-role agents on `muse-spark-1.3` as the control group. Pinning is outside this card (changing models is out of scope) and needs an owner of the agents' configuration.
4. **Expand** only if parks per run drop materially against the control with zero replay 400s reaching agents: drop the `models` list to cover every Meta model, or widen it.
5. **Rollback** is a hot reload with `enabled: false` (immediate, history stays valid), or `swap-image.sh` back.

### Metrics

Baseline from the card (24 h before 2026-10-03): 352 missing-disposition notices, 225 parks, 5,662 succeeded runs (6.2 and 4.0 per 100 runs). I did not re-derive these and have no access to the queries behind them; use the operator's original queries for both arms so the arms are comparable.

| Metric | Source | Expectation |
| --- | --- | --- |
| Missing-disposition notices and parks per run, canary vs control | Paperclip run/event data | Canary materially lower. The card does not define "materially"; I suggest at least a 30 % relative drop with the control arm flat, to be confirmed by the operator before the canary starts. |
| Text-only `end_turn` rate, tool calls per run, merged PRs | Paperclip | Not worse; tool calls per run should not fall |
| Replay 400s that reach agents | CLIProxy access log (400 from `/v1/messages` on Muse) | Zero |
| Safety-net retries | log line `meta reasoning replay: Meta rejected ... retrying once` (`retries_without_replay`) | Near zero. Sustained retries mean Meta binds finer than the account: stop and investigate rather than rely on the net |
| Replay hit rate | `tools/muse_replay_hit_rate.py` over CLIProxy logs | Informational: it bounds how much of the benefit is realised |

Each request that carried envelopes logs one line at info level:

```
meta reasoning replay: model=<m> auth=<auth id> kept=<n> dropped_foreign=<n> dropped_untagged=<n>
```

## Known limits

- **Affinity was measured, not raised.** The session-affinity cache and `routing.session-affinity-ttl` are shared by every lane. Raising the TTL for the Meta pool alone needs a selector change, which would touch Claude and the other lanes' code path, so it is not in this series. A global TTL increase is a config-only option for the operator but changes all lanes, including Claude. Use `muse_replay_hit_rate.py` first: if `dropped_foreign` is high, find out whether bindings are expiring (idle gap longer than the TTL), the bound account is cooling down (quota 429 reselect, visible in the existing `session-affinity: cache hit but auth unavailable, reselected` lines), or CLIProxy restarted. Only the first is fixed by a longer TTL. A better lever may be provenance-aware selection (prefer the account named by the newest tag in the request), which survives restarts and TTL expiry; that is a core-selector change and is proposed as a separate follow-up, not built here.
- **Streaming rejections inside a 200 body are not retried.** `response.created` has already reached the client by then, so a retry would replay it. The tog.2 failures were plain HTTP 400s, which the streaming path does retry.
- **A pseudonymous account hash reaches the client** inside the signature (16 hex characters, the first 8 bytes of a salted SHA-256 of the auth id, stable per account). The salt is a public constant, so a client that already holds a guess of an auth id (typically an email or file name) can confirm it offline; it exposes no token or secret. It lets a client correlate which pool account served a turn. Acceptable while every client is one of our own agents; when this goes upstream, derive it with an HMAC keyed by an instance secret.
- **Signatures grow** by 22 characters (`meta#`, 16 hex, `#`).
- **`CountTokens`** applies the same filtering, so a count never includes envelopes the request would not send.

## Upstream

This is an upstream defect (the Meta executor drops reasoning, and the obvious fix is unsafe with a multi-account pool). The four commits are written to go upstream unchanged: conventional titles, the account-binding behaviour explained in the executor commit, default off. Filing is subject to the usual audits, Steward and CEO sign-off and goes alongside the TOG-3403 alias fix. It has not been filed.
