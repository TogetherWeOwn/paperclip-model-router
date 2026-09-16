# TOG-2922 — v0.4.5 pace-ordering release handoff

## Scope

This handoff makes the later `capacityRouting.paceOrdering: true` write a real
one-key change. It does **not** authorize or perform a live plugin install or
company-config mutation.

The release bundle contains `release-manifest.json`; verify its source SHA,
package SHA-256, and `dist/worker.js` SHA-256 before using any command below.
Version `0.4.2` must not be rebuilt or reused.

## Why the prerequisite is separate

The deployed config has four sources and no `sources[].pace` blocks. Applying the
flag before the prerequisite would be inert. The reviewed prerequisite file is
`docs/operator/tog-2922-pace-prerequisites.json`; the deterministic transformer is
`scripts/tog-2922-config-delta.mjs`.

`prepare` changes only:

- `capacityRouting.pacePolicy`;
- `capacityRouting.paceOrdering` to explicit `false`;
- one `pace` block on each existing source.

It refuses a source set other than exactly `cliproxy-claude`,
`cliproxy-codex`, `cliproxy-kimi`, and `cliproxy-opencode-go`, and verifies that
all other config — including the 107-model roster and secret references — is
byte-for-byte equivalent after canonical JSON ordering.

Kimi currently publishes health, weight, governing-window, duration, and
freshness fields but no real utilization/reset pair. Its health-only block uses
`windows: []`; v0.4.5 retains an explicit fail-neutral `unknown` verdict instead
of fabricating telemetry or discarding the lane.

## Install and prerequisite migration

These are instance-admin commands. The install route is deliberate: the ordinary
upgrade path stops the old worker and then rejects the database capability
increase carried by current `main`. The instance-admin install action is the
capability-approval boundary and applies migrations transactionally.

```bash
set -euo pipefail
PLUGIN='togetherweown.paperclip-model-router'
COMPANY_ID='ef993a7e-5ea7-445f-ba88-27a6a2690c3a'
BUNDLE='/secure/path/tog-2922-model-router-v0.4.5'
TGZ="$BUNDLE/togetherweown-paperclip-model-router-0.4.5.tgz"
NEW_DIR='/paperclip/plugin-packages-root/model-router-0.4.5'
BACKUP='/secure/path/model-router-config-before-tog-2922.json'

sha256sum -c "$BUNDLE/SHA256SUMS"
npx paperclipai plugin config "$PLUGIN" -C "$COMPANY_ID" --json > "$BACKUP"

test ! -e "$NEW_DIR"
mkdir -m 0755 "$NEW_DIR"
tar -xzf "$TGZ" -C "$NEW_DIR" --strip-components=1
npm install --prefix "$NEW_DIR" --omit=dev --ignore-scripts

# Board-only capability-approved install. Do not substitute `plugin upgrade`.
npx paperclipai plugin install "$NEW_DIR" --json | tee "$BUNDLE/install-result.json"

node "$NEW_DIR/scripts/tog-2922-config-delta.mjs" prepare \
  --input "$BACKUP" \
  --output "$BUNDLE/config-prerequisite.payload.json"

npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c . "$BUNDLE/config-prerequisite.payload.json")" \
  --json | tee "$BUNDLE/prerequisite-write-result.json"

npx paperclipai plugin action "$PLUGIN" refresh-capacity \
  --payload-json "$(jq -nc --arg companyId "$COMPANY_ID" '{companyId:$companyId,params:{}}')" \
  --json | tee "$BUNDLE/prerequisite-refresh-result.json"

node "$NEW_DIR/scripts/tog-2922-prerequisite-refresh-gate.mjs" \
  "$BUNDLE/prerequisite-refresh-result.json"
```

Do not continue if that gate fails; it exits non-zero and names each lane at
fault.

Counting the four lane keys is **not** enough, which is why this is a script
rather than a `jq` one-liner. A lane whose `utilizationFields` no longer match
what its collector publishes still appears as a key, carrying
`state: "unknown"` and a null score. The keys-only assertion shipped in the
first v0.4.4 cut passed exactly that broken prerequisite (TOG-2993). The gate
therefore requires:

- `cliproxy-claude`, `cliproxy-codex`, `cliproxy-opencode-go` — each a
  non-`unknown` state **and** a non-null `score`;
- `cliproxy-kimi` — exactly `unknown`. It publishes no utilization/reset pair,
  so its block is deliberately `windows: []`; a *computable* Kimi verdict means
  the lane document changed and the pace blocks need re-deriving.

The same rule is asserted in CI against the reviewed blocks
(`tests/tog-2922-prerequisite-refresh.spec.ts`), so the install gate and the
release gate cannot drift apart.

## Later one-key enable

This is the separate write owned by TOG-2921. The transformer refuses drift in
any reviewed prerequisite field and changes only the boolean.

```bash
node "$NEW_DIR/scripts/tog-2922-config-delta.mjs" enable \
  --input "$BUNDLE/config-prerequisite.payload.json" \
  --output "$BUNDLE/config-enabled.payload.json"

npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c . "$BUNDLE/config-enabled.payload.json")" \
  --json | tee "$BUNDLE/enable-write-result.json"
```

The one-key rollback is the same config write with
`capacityRouting.paceOrdering: false`; re-running `prepare` against the saved
pre-enable prerequisite payload produces that exact state.

## Full rollback

This restores both halves named in the issue: the currently deployed package
and the pre-migration company config.

```bash
set -euo pipefail
PLUGIN='togetherweown.paperclip-model-router'
COMPANY_ID='ef993a7e-5ea7-445f-ba88-27a6a2690c3a'
OLD_DIR='/paperclip/plugin-packages-root/model-router-0.3.0'
BACKUP='/secure/path/model-router-config-before-tog-2922.json'
ROLLBACK='/secure/path/model-router-config-rollback.payload.json'

# Reinstall the exact package directory currently recorded by the live plugin row.
npx paperclipai plugin install "$OLD_DIR" --json

node "$OLD_DIR/scripts/tog-2922-config-delta.mjs" restore \
  --input "$BACKUP" \
  --output "$ROLLBACK"

npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c . "$ROLLBACK")" \
  --json
```

If the old installed directory does not contain the transformer, use the
v0.4.5 bundle's transformer for `restore`; that command copies the saved config
without adding any pace fields.

## Verification evidence

The release was accepted against an authenticated, read-only fetch of all four
live lane documents and the current 200-record decision ring:

- refresh produced four non-empty verdict entries;
- Claude was behind, Codex and OpenCode Go were ahead, and Kimi was explicit
  unknown because its collector exposes no utilization/reset pair;
- one classifiable unpinned mechanical decision changed from the OpenCode Go
  lane to the furthest-behind Claude lane;
- the replacement was already in the same 27-model survivor pool, so pace did
  not cross quality, capability, context-window, or tier gates.

The exact counts and lane deviations are in the bundle's
`pace-refresh-report.json` and `pace-replay-report.json`.
