# TOG-2474 — repoint the opencode-go collector block at the v0.4.0 aggregate route

**Status: patch-artifact handoff, not yet applied to the live host.** This repository does not own
the collector — it runs on the operator's host, outside this checkout. No production process is
touched by authoring this doc; an operator must apply the patch and restart the collector unit
below before the fix takes effect.

**Result:** one patch against the real deployed collector (`cliproxy_usage_snapshot.py`, current
live-host SHA-256 `d6792fa1df6cadfe6f65ee1a94327b4916d2f32bb8cb1c44e509f90ee682ffb1`, the state left
by [TOG-2135](TOG-2135-collector-delta.md) on 2026-09-11). Patch artifact hash:

- `docs/operator/TOG-2474-opencode-go-route.py.patch` — sha256 `9af53a9b9ffe57bb78327acdaccdc51672155c753e839b04fa94b2d863672de2`

## Defect

`cliproxy_usage_snapshot.py`'s opencode-go block calls `mgmt("/plugins/opencode-go-pool/status")`.
That plugin was retired by the v0.4.0 install; the route now 404s (per `main.log`). Left
unpatched, `opencode-go.json`'s `observedAt` stops advancing and the exhausted-lane exclusion for
that pool degrades silently.

**`zai.json` is not affected by this route and needs no code change.** Its block calls Z.ai's own
external quota API (`https://api.z.ai/api/monitor/usage/quota/limit`) directly — it has never
depended on any cliproxy plugin route. TOG-2135's own verification log already recorded it
producing real live data (`weekly_utilization 0.7183`, `weekly_resets_at 2026-09-15T04:09:05Z`)
on 2026-09-11, before this issue was filed. The issue's acceptance criteria mention both files;
only `opencode-go.json` required a fix.

## What the patch does

The v0.4.0 install ships one aggregate management route,
`/v0/management/plugins/subscription-pool/status` (module contract, TOG-2462/PR #34, merged
`87b10cb`, reference implementation `deploy/collector-opencodego.py` in `cpa-plugin-zai-coding-plan`).
Response shape:

```
{plugin: "subscription-pool", status, version, generated_at, providers: {...}}
providers["opencode-go"] = {status, credential_bound, observation_gaps, accounts: [...]}
accounts[] = {name, disabled?, windows: {five_hour, weekly, monthly}}
windows[k] = {known, exhausted, utilization?, resets_at?, source?, authoritative?}
```

The patch:

1. Switches the `mgmt()` call from the dead `/plugins/opencode-go-pool/status` to
   `/plugins/subscription-pool/status`, and reads the response through the new `providers.opencode-go`
   shape instead of the old flat `accounts`/`windows` shape.
2. Uses `utilization` directly as a ratio (`ratio()` clamps to `[0,1]`), instead of `frac()` on the
   old plugin's 0–100 `usage_percent` — the new schema already reports a 0–1 fraction.
3. Treats the module's own boolean `exhausted` per window as authoritative, forcing that window's
   utilization to `1.0` even when `known` is false (no numeric percent, but the module has still
   learned the window is spent — e.g. from a 429). This mirrors the old plugin's
   `blocked`/`suspend_reason` branch, which also forced `weekly`/`five_hour` to `1.0`.
4. Drops `blocked_reason`: the new schema has no free-text reason field, only booleans. Fabricating
   one would violate the standing rule (see TOG-2135 doc) against reporting capability that was
   never observed.
5. Skips accounts the module reports `disabled: true` for, same treatment already given to a
   disabled Claude auth-file lane elsewhere in the same script.
6. Leaves `weight`, `governing_window: "monthly"`, and `window_seconds` exactly as TOG-2135 added
   them — this patch only changes how account/window data is read, not the lane-capacity fields.

`OPENCODE_GO_NO_CN`, `CN_HOSTED_MARKERS`, `is_cn_model`, and the CN-capability logic are untouched.

## Deploy command (exact)

Run as the `ubuntu` user on the host that runs the collector:

```bash
cd /home/ubuntu/paperclip-enterprise-company
cp cliproxy_usage_snapshot.py cliproxy_usage_snapshot.py.tog2474.bak
sha256sum cliproxy_usage_snapshot.py   # expect d6792fa1df6cadfe6f65ee1a94327b4916d2f32bb8cb1c44e509f90ee682ffb1
git apply --check /path/to/TOG-2474-opencode-go-route.py.patch   # from this doc's directory
git apply /path/to/TOG-2474-opencode-go-route.py.patch
python3 -m py_compile cliproxy_usage_snapshot.py
sha256sum cliproxy_usage_snapshot.py   # expect e252456acc992333394c3da351207d6fa070b94596f1bdb80e9a833d9cec729a

systemctl --user start cliproxy-usage-snapshot.service
systemctl --user status cliproxy-usage-snapshot.service --no-pager
curl -sS -H "X-Api-Key: $CLIPROXY_USAGE_LANE_KEY" https://router.infextion.net/telemetry/cliproxy/opencode-go.json
curl -sS -H "X-Api-Key: $CLIPROXY_USAGE_LANE_KEY" https://router.infextion.net/telemetry/cliproxy/_status.json
python3 packages/lane-capacity/scripts/check_lane_docs.py --base-url https://router.infextion.net/telemetry/cliproxy --api-key "$CLIPROXY_USAGE_LANE_KEY"
```

No Caddy change is required — this patch only changes which upstream management route the
collector polls; the served file path and its route allow-list are unchanged from TOG-2135.

## Rollback (exact)

```bash
cd /home/ubuntu/paperclip-enterprise-company
cp cliproxy_usage_snapshot.py.tog2474.bak cliproxy_usage_snapshot.py
sha256sum cliproxy_usage_snapshot.py   # must read back d6792fa1df6cadfe6f65ee1a94327b4916d2f32bb8cb1c44e509f90ee682ffb1
systemctl --user start cliproxy-usage-snapshot.service
```

This restores the exact pre-TOG-2474 collector script (the TOG-2135-patched state), which reads
the now-404 `/plugins/opencode-go-pool/status` route again — `opencode-go.json` will resume going
stale, which is the defect this patch fixes, so only roll back if the new route itself is found to
be broken.

## Verification performed pre-deploy (no live host access)

```bash
# reconstruct the exact live-host baseline: pristine export -> TOG-2135 patch -> verify hash
cp /paperclip/operator-handoff/TOG-2163-export/cliproxy_usage_snapshot.py .
sha256sum cliproxy_usage_snapshot.py   # ff98c663a7b35b959d6e1270afbafe23329861ae1b3795963db6169539c713fd
git apply TOG-2135-collector-delta.py.patch
sha256sum cliproxy_usage_snapshot.py   # d6792fa1df6cadfe6f65ee1a94327b4916d2f32bb8cb1c44e509f90ee682ffb1 (matches documented live-host hash)

# apply this patch on top
git apply --check TOG-2474-opencode-go-route.py.patch
git apply TOG-2474-opencode-go-route.py.patch
python3 -m py_compile cliproxy_usage_snapshot.py
sha256sum cliproxy_usage_snapshot.py   # e252456acc992333394c3da351207d6fa070b94596f1bdb80e9a833d9cec729a
```

Both applies were confirmed clean (`git apply --check`) against the reconstructed live-host state,
not a guess — the intermediate hash after the TOG-2135 patch was checked against the hash TOG-2135's
own doc recorded as the live host's actual post-deploy state before this patch was written or
applied. The edited collector compiles.

Two synthetic `subscription-pool` aggregate responses (one "healthy" case, one with a
`windows.monthly.exhausted: true` account) were built matching the schema in
`deploy/collector-opencodego.py`, run through the patched extraction logic in isolation, and the
resulting `opencode-go.json` records were validated against the real, unmodified
`packages/lane-capacity/scripts/check_lane_docs.py --dir`: both cases passed with zero errors,
using only the `monthly` fields the record's `governing_window: "monthly"` requires.

**Live-host verification (`observedAt` advancing every cycle, `_status.json` showing 0 errors for
the opencode-go group) could not be performed from this run — no host access exists.** That is
necessarily an operator step; record the result here or in a follow-up comment once the deploy
command above has been run, mirroring the "Verification performed on the live host" section in
[TOG-2135's doc](TOG-2135-collector-delta.md).

## Scope

This document was authored as a patch-artifact handoff: no collector process was touched by the
authoring session. Nothing here authorizes further host changes — a new change needs a new
`Operator:` card.
