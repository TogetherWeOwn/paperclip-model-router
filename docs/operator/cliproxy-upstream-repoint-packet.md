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
- Validated mapping (live catalogue, HTTP 200, 181 ids, read-only fetch):
  `cliproxy/gpt-6-luna` is absent (zero `cliproxy/`-prefixed ids served) and
  remaps to `openai/gpt-6-luna` (catalogue-verified verbatim, and matches the
  deployed static alias); `cliproxy/grok-build-0.1` is absent and remaps to
  `grok-build-0.1` (catalogue-verified verbatim, sole neighbour). Every
  further id from Step 1 gets the same verbatim check at apply time; any
  additional miss stops the apply under the rule above.

## Step 3 — Build the payload (deterministic transformer)

```bash
node scripts/cliproxy-upstream-repoint.mjs \
  --input "$BACKUP" \
  --output /secure/path/model-router-cliproxy-repoint.payload.json \
  --credential-secret-id '<approved-cliproxy-secret-ref-uuid>' \
  --remap cliproxy/gpt-6-luna=openai/gpt-6-luna \
  --remap cliproxy/grok-build-0.1=grok-build-0.1
```

The script refuses to run unless the backup's baseUrl is exactly the retired
endpoint (no double-apply), the replacement id is a well-formed UUID different
from the current one, and the protocol is a known compatible protocol. Each
`--remap` must match exactly one roster entry and a target not already
present; undeclared roster drift fails the run. It then asserts everything
outside `upstream.baseUrl`, `upstream.credentialSecretRef.secretId`, and the
declared remap pairs reproduces the backup exactly, and writes the
full-replacement payload with mode `0600`. It prints a summary (protocol,
remaps, model count, model ids) to stderr for the record. If Step 2 surfaced
further misses, add one `--remap` per validated target; a miss with no
validated target stops the apply.

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
pre-change object, including the previous secret ref.

## Step 6 — Post-apply verification

1. Config readback: `plugin config` again and diff against the backup
   excluding the two intended fields; the roster and every other key must be
   identical, and the binding snapshot fields present in the backup must still
   be present.
2. Endpoint shape (unauthenticated, credential-free):
   `curl -sSD - -o /dev/null https://cliproxy.infextion.net/v1/models` must
   return JSON (currently `401` with a JSON body), not `text/plain`.
3. Functional proof is separate: the 32-token agent-tool generation probe runs
   on its own tracking card after apply. This packet is done when the write
   result is recorded and Step 6.1 passes; generation success belongs to the
   probe, not to this packet.

## Pre-apply checklist

- [ ] Backup captured at Step 0 and stored with `0600`; retired baseUrl confirmed in it.
- [ ] Full configured id roster extracted (Step 1); count recorded.
- [ ] Every configured id matched verbatim in the live catalogue (Step 2); no renames smuggled in.
- [ ] Payload built by the reviewed transformer (Step 3); stderr summary archived.
- [ ] Apply targets exactly one company id; other-company configs untouched by construction (`-C` scope + full-replacement body for that company only).
- [ ] Existing binding snapshot preserved in the backup; rollback command tested for syntax (Step 5) before apply.
- [ ] Authorization for the bounded secret-ref reuse recorded; no new key minted, rotated, projected, or hand-pinned.
