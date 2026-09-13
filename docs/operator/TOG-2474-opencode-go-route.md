# TOG-2474 — repoint the opencode-go collector block at the v0.4.0 aggregate route

**Status: applied and verified on the live host on 2026-09-13.** The operator confirmed the
live collector matched the expected pre-patch SHA-256, applied the patch cleanly, compiled it,
and observed fresh telemetry from the aggregate route. The pre-deploy and rollback instructions
remain below as the reproducible change record.

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

## Verification performed on the live host

The operator applied the patch on 2026-09-13 after confirming the live
`cliproxy_usage_snapshot.py` SHA-256 began with `d6792fa1` and matched the documented patch base.
`git apply --check` succeeded, the patch applied, and `python3 -m py_compile` succeeded. Backup:
`cliproxy_usage_snapshot.py.tog2474.bak`.

The first collector cycle after deployment produced:

- `opencode-go.json`: `observedAt: 2026-09-13T20:32:17Z`, three records, all three lanes observed
  as `health: exhausted` from the aggregate subscription-pool response.
- `_status.json`: `opencode-go {lanes: 3, errors: []}` and
  `zai {lanes: 1, errors: [], source: quota-api}`.

This proves the stale-route failure is closed: opencode-go telemetry is advancing from
`/plugins/subscription-pool/status`, while the independent Z.ai quota collector remains healthy.
The identical monthly values across the three OpenCode Go lanes are a separate per-key polling
defect tracked and already fixed for the next installed router release; they are not caused by
this route migration.

## Scope

This document records the deployed TOG-2474 change. Nothing here authorizes further host changes;
a new change needs a new `Operator:` card.
