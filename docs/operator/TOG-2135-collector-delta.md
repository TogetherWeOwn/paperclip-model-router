# TOG-2135 — collector delta for the six lane documents

**Result:** two patches against the real deployed collector (`cliproxy_usage_snapshot.py`, host SHA-256 `ff98c663a7b35b959d6e1270afbafe23329861ae1b3795963db6169539c713fd`) and its Caddy lane (`router-telemetry-lane.caddy`), closing the four gaps TOG-1916 §5.3 lists against `check_lane_docs.py`. Patch artifact hashes:

- `docs/operator/TOG-2135-collector-delta.py.patch` — sha256 `c6ff73ea48d560e6749b3475138fb4e835390cf6287e3b2d1d071f1f81380166`
- `docs/operator/TOG-2135-collector-delta.caddy.patch` — sha256 `a9bfc119fd212b698bf45d2593dfe6f5a8bcb9476b7acbec03f3816451e05478`

Branch head at packaging time: `1318b87fee7f76edf9d9e85e4b6379a163d4dda1` (`tog-2135-lane-capacity`).

This repository does not own the collector or Caddy config — they run on the operator's host, outside this checkout. This is a patch-artifact handoff, not a deploy: **no production collector or router change happens until the operator applies these and restarts the two units below.** Verification ran against an immutable copy of the exported deployed files (`/paperclip/operator-handoff/TOG-2163-export/`, confirmed byte-identical to the live host via `SHA256SUMS`), not against the live host process.

## What TOG-1916 §5.3 required, and what this patch does about each

1. **`zai.json` 404s today.** `TOG-2135-collector-delta.caddy.patch` adds `/telemetry/cliproxy/zai.json` to the `@telemetryKnown` path allow-list. The collector already writes the file; only the Caddy route was missing.
2. **Numeric `weight` on every record, not only Claude's.** `TOG-2135-collector-delta.py.patch` adds `weight` to every lane (Claude, Codex, Kimi, opencode-go, Z.ai, zen-free). Claude keeps its real per-account cliproxy-reported weight (Max 20x=2 / 5x=1), falling back to `DEFAULT_WEIGHT=1` only if cliproxy omits it. Codex, Kimi, opencode-go, and Z.ai have no per-plan multiplier table today (Codex's `plan: "pro"` string has no numeric mapping), so they get `DEFAULT_WEIGHT=1` explicitly, not a silent zero. This makes explicit the ambiguity TOG-1916 §8 flags about Claude's weight semantics: it is plan-size capacity weight, not an operator routing preference, and every other lane is equal-weighted until an operator supplies real per-plan values.
3. **Non-null `*_resets_at` for exhausted accounts wherever the provider reports it.** Codex and Z.ai already had this from their real APIs (`limit_window_seconds`/`reset_at`, `nextResetTime`). opencode-go pool's per-window `reset_at` was already read but not tied to a `governing_window`; that binding is added. **Kimi is the one lane this patch cannot fix**: the collector's `/coding/v1/usages` call has never had its 200-body fields mapped (see `raw_shape` diagnostic — only key names are logged, no values), and neither the healthy path nor the `resource_exhausted`/429 path has ever produced a real reset timestamp. This patch does not fabricate one. `kimi.json` will still fail `check_lane_docs.py` (`weekly_resets_at must be a non-null ISO timestamp`) until an operator captures a real 200 sample and the field mapping is done as separate follow-up work — see "Residual gap" below.
4. **`window_seconds` per window and a `governing_window` hint.** Added to every non-free lane: Claude `{five_hour: 18000, seven_day: 604800}` governing `seven_day`; Codex/Kimi/Z.ai `{weekly: 604800}` governing `weekly` (Codex additionally trusts the real per-window `limit_window_seconds` from its API when present); opencode-go `{five_hour: 18000, weekly: 604800, monthly: 2592000}` governing `monthly`. `zen-free.json` gets `governing_window: null` (free lane, per the fixture contract). `five_hour` is never `governing_window` for any lane — this mirrors the standing owner rule (2026-08-25) already encoded in `base_health`/`state_of` nearby in the same file, now made explicit for the pace model.

`observedAt`, `staleAfterSeconds`, `observationQuality`, `blocked_reason` are untouched, per §5.3 item 5.

## Residual gap: `kimi.json` will not pass validation as-is

This is intentional, not an oversight. TOG-1916 §5.3 requires `weekly_resets_at` to be non-null for exhausted accounts "wherever the provider reports it" — Kimi's collector integration has never captured that value. Inventing one would violate the company's own rule against reporting capability that was never tested. The patch adds the structurally-required `weight`/`governing_window`/`window_seconds` fields (safe: they are policy constants, not observed data) and leaves `weekly_utilization`/`weekly_resets_at` genuinely absent outside the one case where "exhausted" is self-evidently `utilization=1.0` (a 429/`resource_exhausted` response), which still has no reset timestamp. A live `kimi.json` under this patch fails `check_lane_docs.py` with exactly that one violation — confirmed by running the real validator against synthetic docs built from every code path in the patched collector (see Verification below). Closing this needs an operator to capture one real 200 response body from `https://api.kimi.com/coding/v1/usages` so the field mapping can be written against real shape, not the `raw_shape` diagnostic alone.

## Deploy command (exact)

Run as the `ubuntu` user on the host that runs the collector and Caddy:

```bash
cd /home/ubuntu/paperclip-enterprise-company
cp cliproxy_usage_snapshot.py cliproxy_usage_snapshot.py.tog2135.bak
git apply --check /path/to/TOG-2135-collector-delta.py.patch   # from this doc's directory
git apply /path/to/TOG-2135-collector-delta.py.patch
python3 -m py_compile cliproxy_usage_snapshot.py

sudo cp /etc/caddy/sites/router-telemetry-lane.caddy /etc/caddy/sites/router-telemetry-lane.caddy.tog2135.bak
cd /etc/caddy/sites
git apply --check /path/to/TOG-2135-collector-delta.caddy.patch
git apply /path/to/TOG-2135-collector-delta.caddy.patch
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

cd /home/ubuntu/paperclip-enterprise-company
systemctl --user start cliproxy-usage-snapshot.service
systemctl --user status cliproxy-usage-snapshot.service --no-pager
curl -sS -H "X-Api-Key: $CLIPROXY_USAGE_LANE_KEY" https://router.infextion.net/telemetry/cliproxy/zai.json
python3 packages/lane-capacity/scripts/check_lane_docs.py --base-url https://router.infextion.net/telemetry/cliproxy --api-key "$CLIPROXY_USAGE_LANE_KEY"
```

Note: `/etc/caddy/sites/router-telemetry-lane.caddy` is the path this delta assumes from the exported filename; confirm the real include path in the host's `Caddyfile` before applying — this repository has no access to the live Caddyfile to verify it directly.

The last command is expected to **fail on `kimi.json` only** (see Residual gap) until the follow-up field-mapping work lands; that is a pass, not a blocker, for this delta.

## Rollback (exact)

```bash
cd /home/ubuntu/paperclip-enterprise-company
cp cliproxy_usage_snapshot.py.tog2135.bak cliproxy_usage_snapshot.py

sudo cp /etc/caddy/sites/router-telemetry-lane.caddy.tog2135.bak /etc/caddy/sites/router-telemetry-lane.caddy
sudo systemctl reload caddy

systemctl --user start cliproxy-usage-snapshot.service
```

This restores the exact prior collector script (verify: `sha256sum cliproxy_usage_snapshot.py` must read back `ff98c663a7b35b959d6e1270afbafe23329861ae1b3795963db6169539c713fd`) and prior Caddy route (`zai.json` 404s again). No package consumer lockfile changes on the collector host — `@togetherweown/lane-capacity` is consumed only inside this repository's checkout, not on the collector host, so there is nothing to roll back there.

## Verification performed (this session, no live host access)

```bash
git apply --check TOG-2135-collector-delta.py.patch     # against the exported deployed file
git apply --check TOG-2135-collector-delta.caddy.patch  # against the exported deployed file
git apply TOG-2135-collector-delta.py.patch && python3 -m py_compile cliproxy_usage_snapshot.py
sha256sum cliproxy_usage_snapshot.py router-telemetry-lane.caddy
# d6792fa1df6cadfe6f65ee1a94327b4916d2f32bb8cb1c44e509f90ee682ffb1  cliproxy_usage_snapshot.py
# 4b03b775755be55ad7c3ad08772e0c0294c790cb1ddb25c952ca5501af466d99  router-telemetry-lane.caddy
```

Both patches were confirmed to apply cleanly (`git apply --check`) against the real exported deployed files, not a reconstruction. The edited collector compiles. A synthetic document was built for each of the six lanes matching every code path the patched collector can emit (healthy, exhausted, cached, the Z.ai quota/estimator/error fallbacks) and run through the real `packages/lane-capacity/scripts/check_lane_docs.py --dir`: `claude.json`, `codex.json`, `zai.json`, `opencode-go.json`, `zen-free.json` all pass; `kimi.json` fails with exactly the one documented violation, confirmed on both the healthy-unknown path and the exhausted path.

## What this does not authorize

Patch and verification only. No collector process, Caddy config, or systemd unit on the live host was touched by this session. The operator executes the deploy command above at their discretion; this doc and its two patches are the entire handoff.
