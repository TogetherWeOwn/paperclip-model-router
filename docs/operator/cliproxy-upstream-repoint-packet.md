# CLIProxy upstream repoint packet (immutable)

## Purpose

Move this company's model-router compatible upstream off the retired
`https://router.infextion.net` endpoint onto the healthy
`https://cliproxy.infextion.net` endpoint, swapping the upstream credential
reference to the already-existing, approved CLIProxy secret ref. The worker
sends configured model ids verbatim in the request body
(`src/inference/adapters.ts`: `model: modelId` for both the OpenAI and the
Anthropic protocol builders), so a URL-only swap is not a repair: every
configured id needs dynamic acceptance evidence from CLIProxy first.

This packet performs **no live mutation by itself**. Every write below is an
explicit host-operator command run after authorization. No credential values
appear anywhere in this packet; the replacement secret id is supplied on the
command line from the bounded-reuse approval and echoed nowhere except into
the payload file.

## Preconditions

- Host operator with instance-admin plugin-config access.
- The bounded-reuse approval for the existing CLIProxy secret ref (company +
  plugin + `upstream.credentialSecretRef` scope only; no mint, rotation, env
  projection, hand-pinning, or roster change).
- `jq` and `node` on the host.

## Step 0 — Backup (read-only)

```bash
set -euo pipefail
PLUGIN='togetherweown.paperclip-model-router'
COMPANY_ID='<company-id>'
BACKUP='/secure/path/model-router-config-before-cliproxy-repoint.json'

npx paperclipai plugin config "$PLUGIN" -C "$COMPANY_ID" --json > "$BACKUP"
chmod 600 "$BACKUP"
jq .configJson.upstream "$BACKUP"
```

Confirm the backup shows the retired baseUrl before continuing. This file is
the rollback source; preserve it until the post-apply proof passes.

## Step 1 — Enumerate configured model ids (read-only)

```bash
jq -r '.configJson.models[].id' "$BACKUP" | sort -u
jq -c '{protocol: .configJson.upstream.protocol, baseUrl: .configJson.upstream.baseUrl}' "$BACKUP"
```

Record the full id list. The transformer in Step 3 passes the roster through
byte-identical; any rename is a separate, evidence-gated change, never part
of the repoint.

## Step 2 — Read-only catalogue evidence (dynamic acceptance gate)

Static alias inspection does **not** count. For each id from Step 1, prove
CLIProxy accepts it verbatim with an authorized, read-only catalogue fetch.
Resolve the approved CLIProxy key host-side by the standard read-only means;
never paste the value into evidence, logs, or chat.

```bash
CLIPROXY_KEY='<resolved-host-side-only>'
curl -s https://cliproxy.infextion.net/v1/models \
  -H "Authorization: Bearer $CLIPROXY_KEY" \
  | jq -r '.data[].id' | sort -u
```

Acceptance per configured id: the exact string from Step 1 appears verbatim in
this list. Report back only the HTTP status and the id list (no key material).

- Any configured id **absent** from the catalogue: STOP. Do not apply. Report
  the missing id plus the catalogue's closest neighbouring ids; engineering
  supplies a remap on the tracking card and this packet re-runs from Step 0.
- Full-roster outcome (live catalogue, HTTP 200, 181 served, read-only
  fetch): 113 configured ids, 11 verbatim hits (all `opencode-go/` lane ids,
  kept untouched), 102 misses. Zero `cliproxy/`-prefixed ids are served: the
  `cliproxy/` lane label is dead and every such id must move.
- Reconciliation rule (documented per row on the tracking card): vendor
  namespace first (`openai/`, `claude/`, `meta/` -- canonical identity,
  matches the one deployed static-alias precedent), else the bare suffix
  (direct-path precedent), else the proven `opencode-go/` serving lane, else
  `devin/`. Duplicate lane twins of a kept id are disabled, never remapped
  onto the kept id (the transformer refuses duplicate targets).
- Twin pairs sharing one served id coalesce with `--merge`: the live twin
  wins so live coverage never silently goes dark, the loser is disabled, and
  the survivor keeps its entire record (a both-live pair fails for a policy
  decision instead of guessing). Live means runtime-enabled: only an explicit
  `enabled: false` is dark; a missing `enabled` key counts as enabled,
  mirroring `src/config/resolve.ts:146`.
- 47 remaps ship in `docs/operator/cliproxy-roster-decided.txt`. 8 merges plus
  39 disables (11 dead-label twins of kept ids + 28 ids with no catalogue
  candidate at all) ship in `docs/operator/cliproxy-roster-pending.txt` and
  apply ONLY on the explicit policy decision recorded on the tracking card.
  Catalogue absence is necessary but not sufficient evidence -- it proves
  nothing about quota or generation success -- so unserved ids are disabled
  (reversible, entries preserved), never silently dropped.
- If the Step 1 roster differs at all from the 113-id evidence (config
  `updatedAt` moved, count differs): STOP. The transformer refuses unknown
  remap sources and undeclared drift by construction; engineering re-derives
  the flags before any apply.

## Step 3 — Build the payload (deterministic transformer)

```bash
node scripts/cliproxy-upstream-repoint.mjs \
  --input "$BACKUP" \
  --output /secure/path/model-router-cliproxy-repoint.payload.json \
  --credential-secret-id '<approved-cliproxy-secret-ref-uuid>' \
  --flags-file docs/operator/cliproxy-roster-decided.txt
# ONLY on the recorded policy decision, append the pending merges + disables:
#  --flags-file docs/operator/cliproxy-roster-pending.txt
```

Roster actions travel via `--flags-file` (one flag plus its values per line),
never via shell array expansion: the script parses the file itself, and the
spec suite executes this exact `--flags-file` shape end to end. A malformed
line or missing file fails the run before anything is written. A `--merge`
may also be typed directly as `--merge "target srcA srcB"` (quoted) or
`--merge target srcA srcB` (three tokens); both parse to the same triple.

The script refuses to run unless the backup's baseUrl is exactly the retired
endpoint (no double-apply), the replacement id is a well-formed UUID different
from the current one, and the protocol is a known compatible protocol. Each
`--remap` must match exactly one roster entry and a target not already
present; each `--merge` must name two live sources and an unused target, and
the live twin wins (both-live, including default-enabled keyless rows, fails
for a policy decision); undeclared
roster drift fails the run. It then asserts everything outside
`upstream.baseUrl`, `upstream.credentialSecretRef.secretId`, and the declared
`--remap` / `--disable` / `--drop` / `--merge` actions reproduces the backup
exactly, and writes the full-replacement payload with mode `0600`. It prints
a summary (protocol, remaps, merges, disabled, dropped, enabledBefore,
enabledAfter, model count, model ids) to stderr for the record. If Step 2
surfaced further misses, add one action per validated disposition; a miss with
no validated disposition stops the apply.

## Step 4 — Apply (full replacement, one company only)

The supported config route is full replacement: company id plus the complete
`configJson`. The `-C` scope means no other company's config is touched.

```bash
npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c . /secure/path/model-router-cliproxy-repoint.payload.json)" \
  --json | tee /secure/path/model-router-cliproxy-repoint.write-result.json
```

Raw API shape (equivalent): `POST
/plugins/togetherweown.paperclip-model-router/config` with `{ companyId,
configJson }` where `configJson` is the complete new object.

## Step 5 — Rollback (restore backup)

```bash
npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c '{configJson}' "$BACKUP")" \
  --json | tee /secure/path/model-router-cliproxy-repoint.rollback-result.json
```

Rollback trigger: any post-apply verification failure below, or any model
error other than a clean generation after apply. Rollback restores the exact
pre-change object, including the previous secret ref and every roster entry
(remapped ids, disabled twins, and unserved ids all return as they were).

Preservation contract: the Step 0 backup is the only source of truth. Record
`sha256sum "$BACKUP"` and the config `updatedAt` beside the payload; the
readback in Step 6 must diff clean against the backup outside the declared
actions. No entry is ever deleted by this packet except on an explicit
`--drop` the transformer echoes in its summary -- the current packet drops
nothing. Other-company configs are untouched by construction (`-C` scope plus
a full-replacement body for that company only).

## Step 6 — Post-apply verification

1. Config readback: `plugin config` again and diff against the backup
   excluding the declared actions (new baseUrl, new secret ref, 47 remaps,
   8 merges, plus pending disables only if decided); every other key must be
   identical, and the binding snapshot fields present in the backup must still
   be present.
2. Enabled-coverage check: the transformer summary prints `enabledBefore` and
   `enabledAfter` using runtime liveness (a missing `enabled` key counts as
   enabled). Every before-id must resolve to an after-live id via
   identity, remap, or merge win; any dark loss outside the decided disable
   set STOPS the apply (restore the backup, report back). The decided-only
   run must show zero dark losses.
3. Endpoint shape (unauthenticated, credential-free):
   `curl -sSD - -o /dev/null https://cliproxy.infextion.net/v1/models` must
   return JSON (currently `401` with a JSON body), not `text/plain`.
4. Functional proof is separate: the 32-token agent-tool generation probe runs
   on its own tracking card after apply. This packet is done when the write
   result is recorded and Steps 6.1-6.2 pass; generation success belongs to the
   probe, not to this packet.

## Pre-apply checklist

- [ ] Backup captured at Step 0 and stored with `0600`; retired baseUrl confirmed in it; `sha256sum` + config `updatedAt` recorded.
- [ ] Full configured id roster extracted (Step 1); count is 113 and matches the evidence; any drift STOPS the apply.
- [ ] Roster disposition reconciled (Step 2): 11 kept, 47 remapped per the decided flags, 8 twin merges + 39 disables gated on the recorded policy decision; no renames, merges, or disables smuggled in beyond the flag files.
- [ ] Payload built by the reviewed transformer (Step 3); stderr summary archived and shows exactly the declared actions.
- [ ] Apply targets exactly one company id; other-company configs untouched by construction (`-C` scope + full-replacement body for that company only).
- [ ] Existing binding snapshot preserved in the backup; rollback command tested for syntax (Step 5) before apply.
- [ ] Authorization for the bounded secret-ref reuse recorded; no new key minted, rotated, projected, or hand-pinned.
