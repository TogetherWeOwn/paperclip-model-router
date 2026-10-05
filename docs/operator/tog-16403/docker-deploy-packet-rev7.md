# Docker Compose deploy packet: v2026.1001.0-tog.3

**Revised 2026-10-05 (revision 7). STOP pending Gate 0 revalidation of this revision and CEO packet-readiness revalidation.** This supersedes revision 6 (`445d94df-c613-4d2e-a7c7-a9238cc4964d`) of this same document, not the accepted code/review, immutable older tags, the BUILD READY Phase A-C receipt, or the sealed rollback. A revised document, its acceptance, or this card's completion is NOT DRAINED, deployment GO, or permission to undrain. No new build, tag change, live patch, or second restart: candidate `sha256:293eb64e...` and the serving alias are untouched.

**One document for the operator.** This retains the revision-4 fold of §1-§5 of the CTO's [Amendment A](/TOG/issues/TOG-15693#document-docker-deploy-packet-amendment-a) (revision `6d0fd438`), and applies the [CEO retarget decision](/TOG/issues/TOG-13236#comment-13a793ce-9a20-4be8-96be-48f7ec1fdb66) (2026-10-04 23:24Z). Changed relative to revision 4, and nothing else: target tag/object/peeled commit/tree/version (now `-tog.3`); source composition adds PR #18 and PR #42 and their reason; tagged-source inspection adds nested-wake transaction reuse and `isolateRuntime`; candidate/evidence/rollback naming; Phase C/E/F target values; and the target-specific post-recreate receipt adds nonzero `isolateRuntime` source evidence and `/app/FORK_COMMIT` equal to the target. The identity wording is made consistent with that new receipt requirement; no marker-generation step is invented. Every gate, phase order, hold and ownership rule stays as in revision 4. Amendment A §6/§7 remain on [TOG-15693](/TOG/issues/TOG-15693). Gate 0 differences return through the CEO on [TOG-15719](/TOG/issues/TOG-15719); completion is not BUILD READY, DRAINED or deployment GO. Changed relative to revision 6, and nothing else: the persistence mechanism (CEO decision on [TOG-16403](/TOG/issues/TOG-16403), option 1) -- the four approved server fields are persisted into the backed-up canonical compose.yaml during the already-approved drained window, the single-file invocation is kept, the sealed frozen-env rollback is retained, and the multi-file last-`-f` DEPLOY/ROLLBACK invocations are removed. Every gate, phase order, hold and ownership rule stays as in revision 6.

Executor: interactive `paperclip-upgrade-garm-migration` operator only. Authoring card [TOG-13236](/TOG/issues/TOG-13236) performs no host inspection/build, admission change, drain, restart, recreate, `/app` patch, or live proof. Routing and receipts remain on [TOG-9420](/TOG/issues/TOG-9420). Historical tog.4/tog.5/Podman/quadlet runbooks remain STOPPED.

## Accepted anchors (retained, not re-reviewed)

- Target: annotated tag `v2026.1001.0-tog.3`, tag object `24dbd83242b403f211dd2da359948082be680fda`, peeled target `742aa11d332611e8aff16bb9c87a21b527a1cab1`, commit tree `44b05c0f9ad97e85ef9ecffdf3b0bf529fb35455` (fork master head after PR #42; `-tog.2` plus PR #18 nested-wake transaction connection reuse and PR #42 `codex_local` `isolateRuntime`). Earlier H1-H9 PR #33, exit-143 PR #34, PR28 EPIPE and PR29 bounded-redaction content remain in the source lineage. `v2026.1001.0-tog.1` (object `9a63b2ca87ebf3a50c5351ef1e6e1f8462a47deb`, peeled `9df2fb2b4a72f3ea5d9d6e77dc869c28cc4ab85a`) and `v2026.1001.0-tog.2` (object `672c28bca8b3f4bf60b319ce6ad175bf06a1301c`, peeled `5e60ee01b21da036cde5bc7fd779fa8559eb91bd`) are NOT moved and are not the build target. No code delta is authored by this packet. Expected post-deployment health `commit`, baked `server/dist/build-info.json` commit and `/app/FORK_COMMIT` are the full target `742aa11d332611e8aff16bb9c87a21b527a1cab1`.
- Review: [TOG-13241](/TOG/issues/TOG-13241) APPROVE at `a44a1d3a`, squash-merged PR #33; subsequent target/tag direction and #34 evidence remain recorded on this card. Packet correction does not waive any code/CI gate.
- Historical pre-image record (drift comparator only, NOT rollback evidence): `paperclip-local:2026.1001.0-14f66a7-candidate2`; immutable image ID `sha256:9d8e5763e7a99e92f69d08bc107a75ba54e431e08cb8414ca2aec7edd5622ad3`; pre FORK_COMMIT `14f66a7cf6422b43fe87d1d747ceabdf9f23b583`. The rollback anchor is the freshly inspected `PRE_IMAGE_ID` captured in Phase A.
- Known host topology from existing handoffs: rbx1 Docker Compose, `/home/ubuntu/stacks/paperclip/compose.yaml`, service `server`, container `paperclip`. These are recorded assumptions, NOT a fresh Docker inspection.

## Target decision and source composition (Amendment A §1-§2 retained; CEO tog.3 retarget)

The earlier `-tog.2` composition was drafted by the CTO on [TOG-15693](/TOG/issues/TOG-15693) and is retained below. The new target is the CEO-selected fork master: `-tog.2` plus exactly #18 and #42, not a later master snapshot. Items marked "Reviewer-reported" were not re-read by the CTO or by this author. Statements that begin "Operator" are UNVERIFIED until the exclusive operator records them.

| Item | Value |
|---|---|
| Tag (annotated) | `v2026.1001.0-tog.3` |
| Tag object | `24dbd83242b403f211dd2da359948082be680fda` |
| Peeled commit (`TARGET_COMMIT`) | `742aa11d332611e8aff16bb9c87a21b527a1cab1` (fork master head, PR #42 squash) |
| Commit tree | `44b05c0f9ad97e85ef9ecffdf3b0bf529fb35455` |
| Build version string | `2026.1001.0-tog.3` |
| Not moved | `v2026.1001.0-tog.1`: tag object `9a63b2ca87ebf3a50c5351ef1e6e1f8462a47deb`, peeled `9df2fb2b4a72f3ea5d9d6e77dc869c28cc4ab85a` |
| Not moved | `v2026.1001.0-tog.2`: tag object `672c28bca8b3f4bf60b319ce6ad175bf06a1301c`, peeled `5e60ee01b21da036cde5bc7fd779fa8559eb91bd` |

The new annotated tag uses tagger `togetherweown[bot] <togetherweown[bot]@users.noreply.github.com>` through the existing Fork-scoped git credential helper (new ref only, no force; tag message has no internal ticket ID). **Origin receipt (2026-10-05, `git ls-remote`, read-only):** `v2026.1001.0-tog.3` = tag object `24dbd83242b403f211dd2da359948082be680fda`, peeled `742aa11d332611e8aff16bb9c87a21b527a1cab1` = origin `refs/heads/master` (unmoved from the CEO pin); `v2026.1001.0-tog.1` and `v2026.1001.0-tog.2` unchanged as recorded above. Tagged-source spot checks at this tag (public raw, read-only): `grep -c isolateRuntime` in `execute.ts` = 9 with the I1 spans as quoted; `isolated-runtime.ts` present (71 lines, I2 spans as quoted); heartbeat `queryDb` handle, `tx` call sites and H9 guard at the quoted spans. No host, build, health or deployment fact is inferred from this receipt. Same release naming on upstream `v2026.1001.0`: any later approved source change requires a new `-tog.N`; no release tag is moved or re-pointed, and the serving image is never retagged.

Alternatives rejected in Amendment A §1:
- **Move or re-point `-tog.1`:** forbidden; a recorded immutable target.
- **Cherry-pick PR #38 onto `-tog.1`:** produces a tree no PR head or CI run ever saw, and adds nothing because master is already `-tog.1` plus four reviewed PRs.
- **Deploy master / `cut/tog.5-13142` / `-tog.5`:** the `-tog.1`..`-tog.5` line of `v2026.916.1` is a different base; `cut/tog.5-13142` is not an ancestor of the target. Not the serving lineage.
- **Wait for a later master head:** no benefit; this tag pins the CEO-selected commit. If master differs before tag creation, STOP and report to the CEO; do not silently include another commit.

**Serving lineage.** The in-container marker `/app/FORK_COMMIT:1` read by the CTO was `14f66a7cf6422b43fe87d1d747ceabdf9f23b583`. That is a marker read, NOT a Docker/Compose inspection. Its history: upstream `v2026.1001.0` (`8f8a0ab7`) → `ca7da417` (#28 safety rebase) → `14f66a7c` (#29 bounded redaction). The earlier target `-tog.1` (`9df2fb2b`) is `v2026.1001.0` plus 93 commits (H1-H9 wiring #33, exit-143 #34 and earlier fork patches). `14f66a7c` is not an ancestor of `9df2fb2b`; their merge-base is `8f8a0ab7`. This gap is carried as an accepted anchor.

**Delta `-tog.1` → `-tog.2` (`git log 9df2fb2b..5e60ee01`, exactly four commits):**

| PR | Merge | Runtime effect | Independent review / CI evidence |
|---|---|---|---|
| #31 `ci(fork)` | `54801af8f` | None (workflows, CODEOWNERS, e2e-shard pin) | Reviewer-reported (not re-read here): exact-head `b25c52ec` APPROVE; required `ci / verify` + `ci / e2e` green |
| #35 `ci(nightly)` | `829a7c79f` | None (workflows, `scripts/source-onboard-smoke.*`, one `package.json` test-registry line) | Reviewer-reported (not re-read here): exact-head `f1d82b69` approved after three CHANGES rounds; 57/57 checks green incl. CodeQL |
| #37 `fix(codex-local)` | `cc26e5e01` | **Yes**: `codex-home.ts`, `execute.ts` (+ vitest setup). Managed MCP bearer block is removed from `config.toml` at run end; last run on a shared home removes it | Exact-head `d5bb15f9` approved (comment `5978460131`); CI run `37190639123`, 57 checks, all success/skipped incl. CodeQL. Reviewer compared the diff line by line to #36 |
| #38 `fix(workspace-runtime)` | `5e60ee01b` | **Yes**: `workspace-runtime.ts` (+ tests, `doc/DEVELOPING.md`). Truncated `git worktree list` fails closed; 16 MiB list bound; `worktree_list_unavailable` | Exact-head `05c77f65` APPROVE ([TOG-15412](/TOG/issues/TOG-15412#comment-419db691-a6f8-4d8a-8c42-2d9778d9b31b)); CI run `37200473140`, 57 checks, all success/skipped, required `ci / verify` + `ci / e2e` green; PR-only no-Greptile policy applied to this PR only |

**Delta `-tog.2` → `-tog.3` (`git log 5e60ee01..742aa11d`, exactly two commits):**

| PR | Merge | Runtime effect | Existing review / verification evidence |
|---|---|---|---|
| #18 `fix(heartbeat)` | `56d88db4f` | **Yes**: `server/src/services/heartbeat.ts` reuses the existing transaction connection for nested wake reads; regression test and `doc/DATABASE.md` accompany it. | CEO-selected merged lineage; this author verified commit identity, changed-file list and source markers. No new test execution or re-review claimed. |
| #42 `feat(codex-local)` | `742aa11d3` | **Yes**: `codex_local` `isolateRuntime` strips managed MCP gateway configuration for isolated runs and restricts the child launch environment. | CEO reports merged/reviewed and the CISO condition on [TOG-16050](/TOG/issues/TOG-16050); this author verified the source markers and target tree, not a new runtime proof. |

**Why one window:** the `-tog.2` window has not run; Gate 0 [TOG-15719](/TOG/issues/TOG-15719) still needs host-side validation. The CEO chose to include #42 in the same window to close the Codex bearer (`http_headers`) exposure for agents still carrying managed gateways, including Review Bot. `isolateRuntime:true` is already configured on Review Bot (CEO-reported; the serving build ignores it). This packet neither edits that configuration nor claims it has taken effect. No second drain is authorized.

**Identity evidence.**
- Tree of `5e60ee01` (`9ba27de8…`) is byte-identical to the tree of the CI-green, approved PR #38 head `05c77f65`; tree of `cc26e5e01` (`b606facb…`) is identical to the PR #37 head `d5bb15f9`. The tagged tree is exactly what CI and review saw: no merge-drift gap.
- Unchanged between `9df2fb2b` and `5e60ee01` (checked with `git diff --quiet`, all identical): the eight H1-H9 files named in the per-file table below, `server/src/redaction.ts`, `packages/adapter-utils/src/server-utils.ts`, `server/src/services/terminal-cleanup-outcome.ts`, root `Dockerfile` and `server/scripts/write-build-stamp.mjs`. The H1-H9 table, the production-stage/build-stamp recipe and the candidate Entrypoint/Cmd/umask override held verbatim for `-tog.2`. The `-tog.3` runtime changes to heartbeat, codex execution and adapter-utils are inspected separately below; historical byte-equality claims are not extended to files that changed.
- Zero migration files, lockfile, `Dockerfile` or `docker/` changes between the tags. No schema, credential, model-pin or env-pin change in that historical `-tog.1` → `-tog.2` delta.
- Master post-merge push workflows on `5e60ee01` (`docker.yml`, `release.yml`, `source-smoke.yml`) report failure. `docker.yml` (run `37205717738`) fails before any push: `repository name (TogetherWeOwn/paperclip) must be lowercase` in the buildx cache-exporter reference. The `-tog.1` tag-push run `37137956313` and the `cc26e5e01` push run `37191800022` also concluded failure (causes not examined). `release.yml` has no failed jobs (broker summary). `source-smoke.yml` push run not examined. These are not PR gates and do not touch the host Compose build. A `v*` tag push triggers `docker.yml`. Observed for the `-tog.2` tag (run `37209321528`, 14:27-14:31Z): both `build-and-push` jobs failed at the step "Build and push by digest" within seconds (failure cause not read); digest export/upload, `merge-and-push` and canary promotion were skipped, so no image was pushed to GHCR. Do not "fix" that workflow as part of this deployment.

**Migration note (unchanged, now explicit).** First boot of the target applies `0284_petite_genesis.sql` (`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "keyboard_shortcuts" boolean DEFAULT false NOT NULL`; upstream #14141, present in `-tog.1`, `-tog.2` and `-tog.3`). It is additive with a default, so an image rollback should tolerate it (CTO reading of the SQL, not tested). No DB rollback is part of this packet and none may be attempted.

**Independently re-checked by this author on 2026-10-04 (git objects only, no host, no Docker):** both tags read back from origin as recorded and `-tog.1` unmoved; `9df2fb2b..5e60ee01` is exactly the four commits #31, #35, #37, #38; tree of `5e60ee01` is `9ba27de8…`; the eight H1-H9 files, `redaction.ts`, `server-utils.ts`, `terminal-cleanup-outcome.ts`, `Dockerfile` and `write-build-stamp.mjs` are identical between the tags; no migration, lockfile, `docker/` or `patches/` change, and the `package.json` delta is the single `test:release-registry` line; the W1/W2 markers below sit at the quoted lines. (Those are revision-4 checks of the earlier tag pair, retained as historical evidence, not newly claimed for `-tog.3`.)

**Revision-5 git-object checks (no host, Docker or runtime):** origin master equals `742aa11d332611e8aff16bb9c87a21b527a1cab1`, tree `44b05c0f9ad97e85ef9ecffdf3b0bf529fb35455`; `-tog.2..742aa11d` is exactly #18 and #42. The new delta has twelve changed paths and no DB/migration, lockfile, `Dockerfile`, build-stamp, `docker/`, workflow, `patches/` or `package.json` change. `workspace-runtime.ts`, `codex-home.ts`, `Dockerfile` and `write-build-stamp.mjs` are byte-identical to `-tog.2`. Target-source `isolateRuntime` count in `execute.ts` is 9; nested-wake and H9 source spans are located below. These are git-object checks, not tests, a new security verdict or a host receipt. Tag receipt is recorded above; no host-side Gate 0, build or deployment fact is inferred from it.

## Gate 0 — exclusive operator validates host assumptions (before execution)

The operator returns validation/corrections through the CEO on [TOG-9420](/TOG/issues/TOG-9420), naming this document revision. Confirm:

1. Container/service, Compose project name, working directory, full ordered `-f` file set, `--env-file` inputs/profiles, and the actual `server.build` context/Dockerfile/target/args. Derive the project/file metadata from the running container's `com.docker.compose.*` labels and the operator's real invocation; never assume a clone elsewhere is the existing build context.
2. The build recipe below can use the exact tagged source and reviewed tagged Dockerfile while preserving necessary host build options, with explicit `target: production` (the last stage is `cloud`, not production). The receipt form is AGREED by the CEO (decision on [TOG-13236](/TOG/issues/TOG-13236), 2026-10-04 14:43Z; record on [TOG-9420](/TOG/issues/TOG-9420)): health `commit` and the baked `server/dist/build-info.json` commit equal the target, the running container's image ID equals the candidate ID, and PID 1 reports `Umask: 0077`; the CEO's tog.3 receipt extension additionally requires `/app/FORK_COMMIT` equal to the target and nonzero `isolateRuntime` in the target execute source (see Phase B). No further receipt-form agreement is needed. Stop if a different Dockerfile, extra source context, source bind mount over `/app`, build-time source substitution, or unreviewed source patch is necessary. No credentials or raw inspect/config/environment output in comments.
3. Compose supports the chosen JSON/config, build, and up options. The candidate build file is separate, contains only the candidate build service, and cannot tag any serving image. Host CPU/RAM/disk/IO headroom and build secrets remain within existing policy; queue count is not capacity/spend authority.
4. The running image ID and `/app/FORK_COMMIT` marker match the historical record above (drift check; the running image's `build-info.json` is NOT a valid comparator: it reads `8f8a0ab7…` while its health response reads `14f66a7c…`); resolved Compose configuration matches the running service. Secure backup includes every active Compose input and its interpolation inputs. Rollback render reproduces the current service configuration (except the explicit image-ID-anchored rollback reference).
5. Candidate entrypoint/Cmd and the existing umask wrapper agree with the coordinated handoff below. Persistence for this revision is the canonical-file edit (no `-f` override): validate that `/home/ubuntu/stacks/paperclip/compose.yaml` is the single file the restart automation (`ops/paperclip/drain-restart.sh:13`) loads, that the sealed Phase A backup covers it byte-identically, that only the four server fields will change, and that the sealed frozen-env rollback (rollback alias plus the `restore` invocation in `state.json`) restores it. Gate 0 revalidation of this revision is required before CEO readiness review on [TOG-9420](/TOG/issues/TOG-9420).

No host executor was substituted. If any assumption differs, return the concrete metadata difference for this same packet to be amended; do not silently adapt and execute. CEO revalidates readiness before inviting the operator to prepare/build.

## Phase A — seal rollback BEFORE clone/build/retag (operator after readiness GO)

Use one exclusive operator window and Bash with `set -euo pipefail`; do not use `set -x`. The following variables live only in that operator session. `LIVE` is the exact validated single-file Compose command prefix (canonical compose.yaml, no `-f` override), not a guessed invocation.

```bash
set -euo pipefail
umask 077
STACK=/home/ubuntu/stacks/paperclip        # base assumption; Gate 0 validates
CONTAINER=paperclip
SERVICE=server
TAG=v2026.1001.0-tog.3
EXPECTED_TAG_OBJECT=24dbd83242b403f211dd2da359948082be680fda
EXPECTED_TARGET_COMMIT=742aa11d332611e8aff16bb9c87a21b527a1cab1
EXPECTED_TARGET_TREE=44b05c0f9ad97e85ef9ecffdf3b0bf529fb35455
BUILD_VERSION=2026.1001.0-tog.3
HISTORICAL_PRE_IMAGE=sha256:9d8e5763e7a99e92f69d08bc107a75ba54e431e08cb8414ca2aec7edd5622ad3  # drift comparator ONLY
EXPECTED_PRE_COMMIT=14f66a7cf6422b43fe87d1d747ceabdf9f23b583
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE=$(mktemp -d "$STACK/tog3-$STAMP.XXXXXXXX")
chmod 700 "$EVIDENCE"

# Fresh immutable capture of what is running NOW, before any clone, build or tag:
PRE_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
PRE_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$CONTAINER")
PRE_IMAGE_REF=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")
PRE_SERVING_ALIAS_ID=$(docker image inspect --format '{{.Id}}' "$PRE_IMAGE_REF")
PRE_COMMIT=$(docker exec "$CONTAINER" cat /app/FORK_COMMIT)
test "$(docker image inspect --format '{{.Id}}' "$PRE_IMAGE_ID")" = "$PRE_IMAGE_ID"
test "$PRE_SERVING_ALIAS_ID" = "$PRE_IMAGE_ID"
test "$PRE_COMMIT" = "$EXPECTED_PRE_COMMIT"
if [ "$PRE_IMAGE_ID" != "$HISTORICAL_PRE_IMAGE" ]; then
  echo "DRIFT: running image differs from the historical record; STOP and report to the CEO on TOG-9420"; exit 1
fi
ROLLBACK_REF="paperclip-local:rollback-14f66a7-tog3-$STAMP"
# No clone, build or tag write until the configuration/input backup below is complete.
```

Rules (Amendment A §3):
- The **rollback anchor is the freshly inspected `PRE_IMAGE_ID`**. `sha256:9d8e5763…` is a historical record, not fresh rollback inspection. A mismatch (for example after the [TOG-14318](/TOG/issues/TOG-14318) fallback recreate) stops the run and goes back to the CEO; do not proceed on the historical value and do not silently adopt a new one.
- The pre-image drift check uses the image ID and the running container's `/app/FORK_COMMIT` marker only. It must NOT use the running image's `build-info.json` (that file reads `8f8a0ab7…` while the running health response reads `14f66a7c…`).
- Pre-build rollback receipt (non-secret): pre container ID, image ID, FORK_COMMIT, alias-equality result, backup file list with modes and hashes, configuration-equality result.
- The `docker tag "$PRE_IMAGE_ID" "$ROLLBACK_REF"` step below is executed BEFORE the clone and BEFORE any build. Never overwrite an existing rollback alias; never retag `paperclip-local` or any serving alias.

Before any build, the operator defines `LIVE=(docker compose --project-name "$PROJECT" --project-directory "$STACK" ...all validated -f/--env-file/profile options...)`. The ellipsis is deliberately NOT an executable default; Gate 0 must supply the actual invocation. Capture `"${LIVE[@]}" config --format json > "$EVIDENCE/compose.before.json"`. Copy the active raw Compose files, referenced env/interpolation files, and any existing umask wrapper into this **host-local** 0700 directory with 0600 files; save the ordered invocation/input manifest and hashes. Never upload these sensitive snapshots or print them. No `printenv`, unrestricted `docker inspect`, or config dump in logs.

Prepare `RESTORE` from those preserved inputs using the same project name/directory, resolved mount paths and frozen interpolation inputs. Render/compare privately before proceeding. Record only non-secret facts: pre container/image IDs, FORK_COMMIT, rollback-alias equality, configuration backup exists with restrictive modes, and configuration equality result. **A historical tag or tag name alone is not rollback evidence.** Do not retag `paperclip-local` or any active image alias. Only after this complete backup and its restore-render check:

```bash
test -s "$EVIDENCE/compose.before.json"
# Stop if this new rollback alias already exists; never overwrite it.
if docker image inspect "$ROLLBACK_REF" >/dev/null 2>&1; then exit 1; fi
docker tag "$PRE_IMAGE_ID" "$ROLLBACK_REF"
test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_REF")" = "$PRE_IMAGE_ID"
```

## Phase B — bind exact tagged checkout to candidate-only Compose build

```bash
SOURCE="$EVIDENCE/source"
git clone --branch "$TAG" https://github.com/TogetherWeOwn/paperclip.git "$SOURCE"   # full clone, no --depth
test "$(git -C "$SOURCE" cat-file -t "refs/tags/$TAG")" = tag
test "$(git -C "$SOURCE" rev-parse "refs/tags/$TAG")" = "$EXPECTED_TAG_OBJECT"
TARGET_COMMIT=$(git -C "$SOURCE" rev-parse "$TAG^{commit}")
test "$TARGET_COMMIT" = "$EXPECTED_TARGET_COMMIT"
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$TARGET_COMMIT"
test "$(git -C "$SOURCE" rev-parse 'HEAD^{tree}')" = "$EXPECTED_TARGET_TREE"
test "$(git -C "$SOURCE" rev-parse 'v2026.1001.0-tog.1^{commit}')" = 9df2fb2b4a72f3ea5d9d6e77dc869c28cc4ab85a
test "$(git -C "$SOURCE" rev-parse 'v2026.1001.0-tog.2^{commit}')" = 5e60ee01b21da036cde5bc7fd779fa8559eb91bd
test -z "$(git -C "$SOURCE" status --porcelain)"
CANDIDATE_REF="paperclip-local:2026.1001.0-tog.3-742aa11-candidate-$STAMP"
if docker image inspect "$CANDIDATE_REF" >/dev/null 2>&1; then exit 1; fi
```

No shallow/partial synchronized checkout; do not switch any shared checkout or replace the live build context. Record the full target SHA. Check the per-file table below (twelve distinct files) against this tagged checkout before building; recursive file counts are not acceptance evidence.

### Per-file acceptance for the 1001 layout (H1-H9, W1/W2, #18 and #42)

Source paths below are relative to SOURCE at [the full pinned commit](https://github.com/TogetherWeOwn/paperclip/tree/742aa11d332611e8aff16bb9c87a21b527a1cab1), and `/app` in the stock production image mirrors this root. Record actual file:line evidence from the operator checkout, not aggregate file counts.

| Hook | Required source file | Required marker / context |
|---|---|---|
| H1 | `packages/plugins/sdk/src/types.ts` | `ToolRunContext` carries optional `budgetSpentFraction?: number`. |
| H2 | `packages/plugins/sdk/src/protocol.ts` | `PluginPerformActionActorContext` carries optional `budgetSpentFraction?: number`. |
| H3 | `packages/plugins/sdk/src/worker-rpc-host.ts` | `finiteNumberOrUndefined`, `Number.isFinite`, and `rawActor?.budgetSpentFraction`; finite-only normalized/frozen actor context. |
| H4 | `server/src/services/budgets.ts` | **`runBudgetSpentFraction`**, `observed / winner.amount`, `Number.isFinite(fraction)`; active positive billed-cents policy with agent/project/company scope precedence and undefined fallback. It does NOT need the lowercase `budgetSpentFraction` literal. |
| H5 + H6/B2 | `server/src/services/tool-gateway.ts` | Both host-authored `budgetSpentFraction: await runBudgetSpentFraction` injection locations; H6 host value occurs AFTER `...input.runContext`, so caller JSON cannot override it (including undefined). |
| H6/B3 + H8 | `server/src/routes/plugins.ts` | B3 host overwrite AFTER `...runContext` in direct dispatcher; H8 `performActionActorContext` / `const stamp = bsf === undefined ? {} : { budgetSpentFraction: bsf }` from authenticated identity. Inspect both blocks, not merely one matching field. |
| H7 | `server/src/routes/openapi.ts` | `/api/plugins/tools/execute` schema has `budgetSpentFraction: z.number().optional()`; schema presence is not caller authority. |
| H9 | `server/src/services/heartbeat.ts` | `cancel-run-invocations` block is guarded by `manager && latestRun && isHeartbeatRunTerminalStatus(latestRun.status)`, resolves `togetherweown.paperclip-model-router`, calls performAction with run ID and system actor `companyId: run.companyId`, bounded 10s timeout and caught lookup/call failures (`orphans linger to TTL`). Target block 26446-26486: terminal guard 26450-26451, lookup/catch 26452-26455, call/context/timeout 26456-26472, call catch 26473-26478 and outer catch 26481-26486. No budget-field assertion in this lifecycle file. |
| W1 (PR #38) | `server/src/services/workspace-runtime.ts` | `const GIT_WORKTREE_LIST_MAX_STDOUT_BYTES = 16 * 1024 * 1024;` (line 279); `class GitOutputTruncatedError extends Error` (931); `async function readGitWorktreeList(` (2719) wrapping the capture with `maxStdoutBytes`; reason code `"worktree_list_unavailable"` in the result union (2664) and returned on an unreadable list (2875). Inspect that the worktree-list readers (around lines 2719-2760 and the admission call at 2866) use the shared helper, not a bare `runGit(["worktree","list",...])`. |
| W2 (PR #37) | `packages/adapters/codex-local/src/server/codex-home.ts` | `release: () => Promise<void>` on the `writeManagedCodexMcpConfig` result (377) and `release: drop` returned (434). |
| W2 | `packages/adapters/codex-local/src/server/execute.ts` | The returned `release` is called from the outer `finally` after provider-config cleanup (767-770 callback declaration; writer/capture at 792-799; provider cleanup plus nested release `finally` at 1676-1691, call/catch at 1682-1689). |

| N1 (PR #18) | `server/src/services/heartbeat.ts` | Runtime/task-session readers take `queryDb: Pick<Db, "select"> = db` and use that handle (11086-11098, 11125-11147); session/resume/workspace resolvers forward it (12185-12302, 26942-26960); responsible-user lookup forwards the same handle (27025-27051); transaction call sites pass `tx` (28075-28078, 28514-28516, 28788-28790). Inspect executable propagation, not only the connection-reuse comment. |
| I1 (PR #42) | `packages/adapters/codex-local/src/server/execute.ts` | `grep -c isolateRuntime` is nonzero (author's target source count: 9). Flag and remote-isolation refusal at 638-653; empty runtime/managed gateway lists plus writer call that strips an earlier managed block at 776-799; API-token injection gated by `!isolateRuntime` at 999-1002; `isolatedRuntimeEnv(env)` at 1019-1031; child launch `inheritServerEnv: !isolateRuntime` at 1388. |
| I2 (PR #42) | `packages/adapters/codex-local/src/server/isolated-runtime.ts` | Newly added runtime helper, imported by `execute.ts:109`: opt-in/default-false detection at 17-20, environment allowlists at 25-55, restricted environment construction at 57-71. Copy/compare this file separately; it is not a test. |

The W1/W2 and #18/#42 line numbers below are source readings at `742aa11d`; the operator records the lines actually read in the clone. H9 remains an operator source check, not a newly executed reap proof: record its actual guard/catch spans before BUILD READY. The new #18 row shares `heartbeat.ts` with H9 and the new #42 execute row shares `execute.ts` with W2; the isolation helper adds one new path, making twelve distinct inspection files. This is the specified release-sentinel inspection, not a claim to re-review every file in #18/#42.

Additional release sentinels: `server/src/redaction.ts` has BOTH `{0,64}` affixes; `packages/adapter-utils/src/server-utils.ts` registers stdin `error` handling for `EPIPE`/`ECONNRESET` before deferred write/end; `server/src/services/terminal-cleanup-outcome.ts` has `isTerminalResultCleanupSuccess` and terminal-result/143/SIGTERM cleanup checks, with heartbeat integration intact. The exit-143 fix ships in this same tag, not a different later HEAD.

Before build, also run `grep -c isolateRuntime "$SOURCE/packages/adapters/codex-local/src/server/execute.ts"` and require a nonzero result (9 lines in the author's pinned source reading). A source marker alone does not prove that an agent has runtime isolation enabled.

For non-aggregate evidence, run `grep -nF` for each table marker in its named source file and inspect the specified surrounding blocks. After creating the never-started candidate below, `docker cp` these same twelve distinct source files to the private evidence directory and `cmp` each against its tagged checkout counterpart; record all twelve file-specific results. The stock production stage copies ALL `/app`, so these sources are available. If the actual approved host recipe omits TS sources, stop and revise the inspection recipe rather than pretend interface names survive compilation.

Also inspect the compiled counterparts: SDK `dist/types.d.ts`, `dist/protocol.d.ts`, `dist/worker-rpc-host.js`; server `dist/services/budgets.js`, `tool-gateway.js`, `heartbeat.js` and `dist/routes/plugins.js`, `openapi.js`. H1/H2 interfaces disappear from runtime JS; comments can disappear during compilation. Check declarations/operational JS in their respective files, with actual layout confirmed by operator. Compiled check for W1: `server/dist/services/workspace-runtime.js` must contain `GitOutputTruncatedError` and `worktree_list_unavailable`. `codex-local` exports its TypeScript sources directly (`./src/...`) and has no `dist`; the `cmp`-verified source file is the runtime artifact for W2 and #42 (including the new isolation helper). The operator confirms the actual layout and returns any difference for revision rather than adapting silently.

Create `$EVIDENCE/candidate.compose.json` as a standalone Compose model with just `services.server.image = CANDIDATE_REF` and `services.server.build`. Its build context MUST be the absolute `SOURCE` path above, not the original live context. Use the tagged Dockerfile/target/build args identified below and the necessary operator-validated build options; this file contains no production environment, ports, volumes, dependencies or container name. Do not merge it with live runtime Compose files. Remove inherited `build.tags`; require that the complete tag output is only `CANDIDATE_REF`. Do not inherit a Dockerfile outside SOURCE, `dockerfile_inline`, alternate source contexts, or a build arg that substitutes an old/wrong source tree. Stop on unsupported host-specific build requirements.

At the pinned tag, root `Dockerfile` has a **production** stage (do not accidentally select the later `cloud` stage). It uses `PAPERCLIP_BUILD_COMMIT` to generate `/app/server/dist/build-info.json` via `server/scripts/write-build-stamp.mjs`; the production stage also exposes the build-commit/version values. Bind the full target into the build, not just into an image name:

```bash
export EVIDENCE SOURCE CANDIDATE_REF TARGET_COMMIT BUILD_VERSION
```

```python
# Operator-local generation only, after Gate 0 validates the actual build options.
import copy, json, os
from pathlib import Path
p = Path(os.environ['EVIDENCE'])
actual = json.loads((p / 'compose.before.json').read_text())
build = copy.deepcopy(actual['services']['server']['build'])
assert isinstance(build, dict), 'STOP: no validated live Compose build recipe'
assert not build.get('dockerfile_inline'), 'STOP: inline/unreviewed Dockerfile'
assert not build.get('additional_contexts'), 'STOP: extra source context needs review'
build.update(context=os.environ['SOURCE'], dockerfile='Dockerfile', target='production')
build.pop('tags', None)  # never carry a serving tag into the candidate-only build
args = build.get('args') or {}
assert isinstance(args, dict)
args.update(PAPERCLIP_BUILD_COMMIT=os.environ['TARGET_COMMIT'],
            PAPERCLIP_BUILD_VERSION=os.environ['BUILD_VERSION'])
build['args'] = args
model = {'services': {'server': {'image': os.environ['CANDIDATE_REF'], 'build': build}}}
# Resolved values are literals; protect any dollar in host-local build values
# against a second Compose interpolation pass. Never print secret build args.
def literal(v):
    if isinstance(v, str): return v.replace('$', '$$')
    if isinstance(v, list): return [literal(x) for x in v]
    if isinstance(v, dict): return {k: literal(x) for k, x in v.items()}
    return v
(p / 'candidate.compose.json').write_text(json.dumps(literal(model), indent=2) + chr(10))
```

**1001 identity distinction (rev6 no-marker rule per [CEO decision](/TOG/issues/TOG-16242#document-ceo-decision-marker-20261005) on [TOG-16242](/TOG/issues/TOG-16242)):** the pinned source at `742aa11d332611e8aff16bb9c87a21b527a1cab1` has no marker mechanism -- `Dockerfile`, `server/scripts/write-build-stamp.mjs` and `scripts/docker-entrypoint.sh` contain zero `FORK_COMMIT` references and the pinned root `FORK_COMMIT` is 404 (verified live) -- and none is invented. Do not claim that a stock build creates `/app/FORK_COMMIT`. BUILD READY uses the candidate immutable image ID + baked `server/dist/build-info.json` commit (= full target) + `/api/health` top-level `commit` (= full target), with explicit `--build-arg PAPERCLIP_BUILD_COMMIT` carry-forward. IF `/app/FORK_COMMIT` exists in the never-started candidate or deployed image it must equal the full target; absence is PASS, not a gap. The OLD image marker still governs Phase A drift and rollback checks. No runtime `/app` write, new unreviewed Dockerfile shim, tag mutation, or invented marker-generation command is authorized.

Before build, render this candidate-only model privately and assert that the effective `build.context` is SOURCE, effective Dockerfile is the tagged file, target/args are verified, and only the distinct candidate reference can be written. Save the non-secret binding tuple (full target SHA, absolute context, Dockerfile identity, target, non-secret source/version args, candidate ref). Build and inspect only after this binding is validated:

```bash
BUILD=(docker compose --project-name "paperclip-h1h9-candidate-$STAMP" \
  --project-directory "$SOURCE" -f "$EVIDENCE/candidate.compose.json")
"${BUILD[@]}" config --format json > "$EVIDENCE/candidate.rendered.json"
# Validate the binding and exclusive image tag before this next command.
"${BUILD[@]}" build "$SERVICE"
CANDIDATE_ID=$(docker image inspect --format '{{.Id}}' "$CANDIDATE_REF")
test "$CANDIDATE_ID" != "$PRE_IMAGE_ID"
```

Inspect candidate identity/content using a **never-started** inspection container, not a service connected to live data:

```bash
INSPECTION_ID=$(docker create --network none --entrypoint /bin/true "$CANDIDATE_ID")
docker cp "$INSPECTION_ID:/app/server/dist/build-info.json" "$EVIDENCE/build-info.candidate.json"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["commit"] == sys.argv[2]' \
  "$EVIDENCE/build-info.candidate.json" "$TARGET_COMMIT"
# No-marker rule (rev6): the pinned source has no marker mechanism and none is invented; absence is PASS. Never add a runtime write.
if docker cp "$INSPECTION_ID:/app/FORK_COMMIT" "$EVIDENCE/FORK_COMMIT.candidate" 2>/dev/null; then
  test "$(cat "$EVIDENCE/FORK_COMMIT.candidate")" = "$TARGET_COMMIT"
else
  echo "FORK_COMMIT absent (expected): no-marker PASS"
fi
FILES=(
  packages/plugins/sdk/src/types.ts packages/plugins/sdk/src/protocol.ts
  packages/plugins/sdk/src/worker-rpc-host.ts server/src/services/budgets.ts
  server/src/services/tool-gateway.ts server/src/routes/plugins.ts
  server/src/routes/openapi.ts server/src/services/heartbeat.ts
  server/src/services/workspace-runtime.ts
  packages/adapters/codex-local/src/server/codex-home.ts
  packages/adapters/codex-local/src/server/execute.ts
  packages/adapters/codex-local/src/server/isolated-runtime.ts
)
for f in "${FILES[@]}"; do
  mkdir -p "$EVIDENCE/candidate-source/$(dirname "$f")"
  docker cp "$INSPECTION_ID:/app/$f" "$EVIDENCE/candidate-source/$f"
  cmp "$SOURCE/$f" "$EVIDENCE/candidate-source/$f"
  echo "$f: tagged/candidate source equality PASS"
done
# Inspect compiled files/layout from the table too; no docker start/run.
docker rm "$INSPECTION_ID"
```

Use only this captured inspection-container ID for cleanup; no name wildcard, prune, live container start, server boot, migrations, production DB tests, or credential substitution. Capture candidate Entrypoint/Cmd locally via selected image-inspect fields for the umask override, without dumping Environment. Inspect the baked identity and file evidence; neither a new tag name nor a build arg alone proves content.

Recheck `PRE_CONTAINER_ID`, `PRE_IMAGE_ID`, live FORK_COMMIT, serving-alias image ID and Compose/input hashes are unchanged since Phase A. Stop on drift, including an umask fallback recreate; resnapshot the current configuration and coordinate again rather than lose its wrapper.

## Phase C — BUILD READY (NO live target health yet)

Exclusive operator posts on [TOG-9420](/TOG/issues/TOG-9420) the source-to-image receipt, one non-secret line each: packet revision, tag `v2026.1001.0-tog.3`, tag object, full `TARGET_COMMIT`, tree, validated context/Dockerfile/target, candidate ref + immutable `CANDIDATE_ID`, baked `build-info.json` commit (= full target) and `/app/FORK_COMMIT` (absent as expected, or equals full target if present), all twelve per-file `cmp` results with H1-H9/W1/W2/#18/#42 marker line numbers actually read and nonzero `isolateRuntime` count, candidate Entrypoint/Cmd match to the umask override below, pre-image equality + rollback alias, secure configuration backup/render equality, planned persistent cutover config with umask, and that no live container, serving alias or Compose input changed since capture. Record checks actually performed and gaps.

BUILD READY means a candidate is built/inspected and rollback is prepared; it does NOT mean target health passed or authorize restart. Existing health still describes `14f66a7cf`, not `742aa11d3`. Do not drain, change admission caps, recreate, run P1/P2, or undrain in this phase.

## Phase D — CEO drain, then explicit DRAINED

CEO reads BUILD READY, records existing admission caps, and uses the approved admission-drain path while current runs finish naturally. No run kills or generic pool-cap increase. CEO supplies explicit DRAINED/quiet-window evidence on [TOG-9420](/TOG/issues/TOG-9420); operator independently confirms quiescence before recreate. A packet approval or elapsed timer is not DRAINED. If the source/image/config/rollback anchors drifted, stop and refresh the handoff rather than cut over with stale evidence.

## Phase E — ONE operator recreate, preserving/applying umask

Coordinate [TOG-13039](/TOG/issues/TOG-13039) and its fallback [TOG-14318](/TOG/issues/TOG-14318): if fallback already applied the wrapper, preserve it in the candidate image recreate and do not schedule a second umask interruption. If this recreate applies it first, record its verification before superseding the fallback. This packet neither cancels the fallback nor grants an extra restart.

After DRAINED, persist the four approved server field changes into the backed-up canonical compose.yaml (`/home/ubuntu/stacks/paperclip/compose.yaml` -- the single file `ops/paperclip/drain-restart.sh:13` loads) during the already-approved drained window, keeping the single-file invocation; no `-f` override file is created, retained, or required. Only `services.server.image`, `entrypoint`, explicit `command`, and the non-secret build-identity environment keys (`PAPERCLIP_BUILD_COMMIT` / `PAPERCLIP_BUILD_VERSION`) change -- the exact values already rendered offline in `release.override.PLANNED.yaml`; keep original mounts/network/security and all other runtime environment. Explicit target identity prevents old Compose environment metadata from masking the candidate stamp. Image is `CANDIDATE_REF` whose ID is verified `CANDIDATE_ID`, never a rebuilt/retagged `paperclip-local`. Procedure: re-hash the live canonical file against the sealed Phase A backup of the active raw Compose files (that backup already covers it -- take no second divergent backup); on mismatch STOP and return to the CEO. Apply only the four field edits, then prove `diff` against the backup shows only those fields and the validated single-file invocation's `config` renders the intended service. Because the fields live in the canonical file the restart script loads, later restarts/automation retain them by construction; the Gate 0 revalidation for this revision confirms the script path and the render before any recreate.

The umask wrapper follows the existing handoff but uses the candidate's **inspected** Entrypoint and Cmd, not guessed commands. Compose `entrypoint` overrides drop image CMD, so `command` must explicitly reproduce the inspected candidate Cmd. For the recorded `tini -- docker-entrypoint.sh` entrypoint shape, the override is:

```yaml
services:
  server:
    image: <validated CANDIDATE_REF>
    entrypoint:
      - /bin/sh
      - -c
      - 'umask 0077 && exec /usr/bin/tini -- docker-entrypoint.sh "$$@"'
      - paperclip-umask
    command: ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
    environment:
      PAPERCLIP_BUILD_COMMIT: 742aa11d332611e8aff16bb9c87a21b527a1cab1
      PAPERCLIP_BUILD_VERSION: 2026.1001.0-tog.3
```

Replace the image placeholder with the literal validated candidate reference in the canonical compose.yaml (no reliance on a temporary shell variable after the session exits). The command above is from the pinned Dockerfile; require candidate inspection to match it. Confirm the inspected entrypoint really matches the displayed prefix; if not, return the actual entrypoint/Cmd for revision. `$$@` is intentional Compose escaping so the container shell receives `$@`. Confirm an additional Compose `init` wrapper does not defeat the PID-1 umask proof. Do not replace the server's arguments or start a diagnostic shell instead of the server.

```bash
# DEPLOY is the validated single-file LIVE invocation: the canonical compose.yaml now carries the four persisted server fields. No -f override.
# Recheck candidate and rollback aliases still resolve to captured immutable IDs.
test "$(docker image inspect --format '{{.Id}}' "$CANDIDATE_REF")" = "$CANDIDATE_ID"
test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_REF")" = "$PRE_IMAGE_ID"
"${DEPLOY[@]}" up -d --no-build --pull never --no-deps --force-recreate "$SERVICE"
test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$CANDIDATE_ID"
docker exec "$CONTAINER" node -e \
  'const fs=require("node:fs"); const b=JSON.parse(fs.readFileSync("/app/server/dist/build-info.json","utf8")); if(b.commit!==process.argv[1]) process.exit(1)' \
  "$TARGET_COMMIT"
MARKER="$(docker exec "$CONTAINER" cat /app/FORK_COMMIT 2>/dev/null || true)"; if test -n "$MARKER"; then test "$MARKER" = "$TARGET_COMMIT"; else echo "FORK_COMMIT absent (expected): no-marker PASS"; fi
ISOLATE_RUNTIME_LINES=$(docker exec "$CONTAINER" grep -c isolateRuntime /app/packages/adapters/codex-local/src/server/execute.ts)
test "$ISOLATE_RUNTIME_LINES" -gt 0
printf 'isolateRuntime source lines: %s
' "$ISOLATE_RUNTIME_LINES"
docker exec -u node "$CONTAINER" grep '^Umask:' /proc/1/status
# Required: 0077. A docker-exec shell's own umask is NOT PID-1 evidence.
```

No compose down, dependency restart, rebuild during drain, independent hotpatch, host credential changes, or undrain by the operator.

## Phase F — target-health/deployment receipt (AFTER recreate)

Use the operator-validated health URL (recorded `http://localhost:3100/api/health`; verify published port before execution): `curl --fail --silent --show-error "$HEALTH_URL"`. Wait only for the agreed bounded startup interval; report timeout/failure, never call it healthy prematurely. Require the health response's **top-level `commit`** equals the full target (the pinned health route exposes it even in the anonymous/redacted response; do not bypass access controls to request full serverInfo). Separately prove container image ID equals CANDIDATE_ID and the baked build-info commit equals the same full target `742aa11d332611e8aff16bb9c87a21b527a1cab1`. `/app/FORK_COMMIT` must equal that target too, and `grep -c isolateRuntime /app/packages/adapters/codex-local/src/server/execute.ts` must be nonzero (Phase E records both). PID-1 `Umask: 0077` completes the agreed receipt form. Runtime environment metadata has precedence in health; health alone is NOT proof of baked source identity.

Post before/after container/image/commit identities, health HTTP/status evidence, H1-H9/W1/W2/#18/#42 file/compiled-artifact evidence, the nonzero `isolateRuntime` count and full `/app/FORK_COMMIT`, preserved umask configuration and PID-1 0077 output on [TOG-9420](/TOG/issues/TOG-9420). After a fresh authorized agent run, CISO/umask owner records new sidecar 0600 + tool-results directory 0700 and the audit result; do not claim that merely from PID-1 umask. CEO owns verification and cap restoration/undrain, not this authoring card or the operator.

## Phase G — P1/P2 unchanged (CEO after restart)

- P1: forged `budgetSpentFraction 0.99` loses; `gates.budget` equals the host value. Register decision row plus host injection log.
- P2: invoke-async orphan yields `invocation-cancelled`. Register cancelled-orphan result plus host reap log.
- Deployment receipt, file evidence and both proofs go on [TOG-7924](/TOG/issues/TOG-7924). Holds [TOG-7139](/TOG/issues/TOG-7139)/[TOG-7171](/TOG/issues/TOG-7171) stay until accepted proofs land. No proof was performed by this packet-authoring run.

## Rollback — immutable pre-image AND preserved configuration

On target-health/startup failure, stay drained; notify CEO and use only the agreed rollback within the existing exclusive operator scope. Copy the sealed canonical-file backup over `/home/ubuntu/stacks/paperclip/compose.yaml`, prove byte-equality with the backup, then recreate through the `restore` invocation recorded in `state.json` (the validated single-file LIVE invocation captured in Phase A). The sealed rollback alias (named `paperclip-local:rollback-14f66a7-tog3-<STAMP>`, anchored to the freshly inspected PRE_IMAGE_ID **before build**) must still inspect to that ID and remains the immutable-image fallback: if the restored canonical file's image reference does not resolve to PRE_IMAGE_ID, STOP and coordinate with the CEO rather than retagging. Never derive rollback from the mutable `paperclip-local` alias, never use the candidate's command with the old image, and never overwrite unrelated post-snapshot edits. Stop on configuration drift and coordinate the exact recovery with CEO.

```bash
test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_REF")" = "$PRE_IMAGE_ID"
# ROLLBACK is the restore invocation recorded in state.json (validated single-file LIVE invocation).
# COMPOSE_BACKUP is the sealed Phase A backup path of the canonical compose.yaml, recorded in state.json.
# ROLLBACK step 1: restore the sealed canonical-file backup, prove byte-equality.
cp "$COMPOSE_BACKUP" "$STACK/compose.yaml"
cmp "$COMPOSE_BACKUP" "$STACK/compose.yaml"
# ROLLBACK step 2: recreate through the restore invocation in state.json (validated single-file LIVE invocation).
"${ROLLBACK[@]}" up -d --no-build --pull never --no-deps --force-recreate "$SERVICE"
test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$PRE_IMAGE_ID"
test "$(docker exec "$CONTAINER" cat /app/FORK_COMMIT)" = "$EXPECTED_PRE_COMMIT"
```

After rollback `/app/FORK_COMMIT` must read `14f66a7cf6422b43fe87d1d747ceabdf9f23b583` and the image ID must equal the fresh `PRE_IMAGE_ID`. Image/config rollback only (see the migration note).

Verify previous health and the preserved configuration/umask state; post rollback identities + health on [TOG-9420](/TOG/issues/TOG-9420). This is an image/config rollback, NOT a DB rollback: never restore/migrate production data as a test. Keep secure snapshots and both images; no pruning/deletion. CEO alone decides cap restoration and the next delivery attempt.

## Verification limits and official command references

Author verification is source/document/command-structure only (git objects and document text; the Amendment A sources are the CTO's; the tog.3 retarget is CEO-directed, with the author's git-object re-check recorded in the source-composition section). The host Compose recipe, live immutable image, backup render, candidate build/inspection, actual health, rollback, umask and P1/P2 are UNVERIFIED until their designated executors record evidence. Pending host validation is not a successful deployment. No local build, typecheck or test suite was run for this revision.

- [CTO Amendment A](/TOG/issues/TOG-15693#document-docker-deploy-packet-amendment-a) (revision `6d0fd438`): source of the retained fold of §1-§5.
- [CEO tog.3 retarget](/TOG/issues/TOG-13236#comment-13a793ce-9a20-4be8-96be-48f7ec1fdb66): pinned #18/#42 target and added receipt markers; earlier tags stay immutable.
- [Compose merge/path resolution](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/): later files override; paths resolve from the base file. Candidate build is deliberately standalone with an absolute context.
- [Compose build tagging](https://docs.docker.com/reference/cli/docker/compose/build/): an explicit service image is the build tag; do not build the live image reference.
- [Compose config](https://docs.docker.com/reference/cli/docker/compose/config/): resolves paths/env by default; snapshots remain host-local and private.
- [Entrypoint/command](https://docs.docker.com/reference/compose-file/services/#entrypoint): non-null entrypoint ignores default image CMD; supply explicit command and escape literal dollars.
- [Compose up flags](https://docs.docker.com/reference/cli/docker/compose/up/): `--no-build --pull never --no-deps --force-recreate` limits the agreed recreate to the prepared local image and chosen service.
