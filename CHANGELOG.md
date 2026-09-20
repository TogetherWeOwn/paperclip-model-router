# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

A company can be pinned to any released version, so the compatibility notes on
each entry matter as much as the feature list. CI refuses to tag a release whose
version is not present here.

## [Unreleased]

## [0.5.0] - 2026-09-19

### Added

- **Async invoke: submit + poll (TOG-3419).** Two new opt-in surfaces sit
  alongside the existing synchronous `model_router_invoke` /
  `POST /invoke`, unchanged: `model_router_invoke_async` /
  `POST /invoke-async` runs selection and credential resolution
  synchronously, writes a pending record, fires the compatible-upstream call
  in the background, and returns `{status: "pending", requestId, decision}`
  immediately. Every request has its own company-scoped state row, so
  concurrent submissions cannot lose one another. `model_router_invoke_result`
  / `GET /invoke/:requestId` polls that record: `pending` while the call runs,
  `not-found` once its TTL elapses, or the terminal `completed`/`error`
  outcome. The background call uses the selected model's own
  `requestTimeoutMs` (up to the worker's 300s ceiling) instead of the 28s sync
  ceiling, so a generation that would overrun Paperclip's 30s host RPC cap can
  still complete. It reaches that ceiling by issuing the upstream request with
  the worker process's own `fetch` (`directFetchHttpClient`) rather than the
  host `ctx.http.fetch` bridge, which hard-aborts every outbound request at 30s
  — the plugin SDK explicitly sanctions direct `fetch` from a worker, and the
  only URL this path reaches is the already-validated `upstream.baseUrl`, so
  SSRF posture is unchanged. The synchronous `/invoke` path still uses the
  host bridge and its 30s cap, unchanged. Audit persistence is isolated from
  the terminal transport outcome, and decision records preserve the full async
  latency instead of truncating it at 60 seconds.
- **`maxSyncOutputTokens`, a new optional per-model config field.** The
  synchronous `/invoke` path now rejects, in milliseconds and before issue
  stickiness, credential resolution, or any upstream call, a `maxOutputTokens` that could not
  finish inside `min(selectedModel.requestTimeoutMs ?? upstream.requestTimeoutMs,
  28_000)` at a 43 tok/s baseline (1200 tokens / 28s, TOG-1035). Its error
  message names the model and points the caller at
  `model_router_invoke_async` instead. `maxSyncOutputTokens` overrides the
  derived budget for a model whose real throughput differs from that
  baseline; omitting it preserves the old default exactly.

Compatibility: drop-in over 0.4.5. No existing config requires changes —
`maxSyncOutputTokens` is optional and the sync `/invoke` path's default
budget matches the ceiling every existing model already inherited. No new
plugin capability is required, so this upgrades through the ordinary
`plugin upgrade` path, unlike the capability-escalating TOG-2922 install.

### Fixed

- **`verify:migrations` crashed on a host-less release runner (TOG-3419).**
  The migration validator forced `PAPERCLIP_HOST=/app` in its npm script and
  read the host's compiled `plugin-database.js` unconditionally, so on a
  self-hosted runner drawn without a host checkout at `/app` it died with
  `ENOENT` instead of skipping. This is what failed the first v0.5.0 release's
  `npm run verify` while the same commit's CI passed on a host-equipped
  runner. It now mirrors `verify:host`'s TOG-1070 probe policy: it runs and
  mirrors when a host checkout is reachable, fails only when a host was
  explicitly requested but is missing, and otherwise SKIPs cleanly. The
  pre-tag gate (`PAPERCLIP_HOST=/app npm run verify:migrations`) still runs
  the full embedded-PostgreSQL rehearsal unchanged.

## [0.4.5] - 2026-09-16

Supersedes the never-tagged 0.4.4 candidate, which was rejected in review
(TOG-2993). Its release gate was vacuous for the Claude lane and its package
silently shipped no operator runbook. 0.4.4 was never tagged or published; no
installation carries it.

Compatibility: unchanged from the 0.4.4 candidate — drop-in over 0.4.2 while
`capacityRouting.paceOrdering` remains false. No runtime behaviour changed in
this version; the fixes are to the release and install gates.

### Fixed

- **The prerequisite gate could not see a Claude lane it had stopped measuring
  (TOG-2993).** The acceptance spec asserted only that each lane returned a
  state *string*, and `unknown` is a string — so renaming Claude's
  `utilizationFields` to nonexistent literals left the suite 4/4 green with
  Claude silently unmeasurable. Claude was the one lane no other assertion
  covered. Each lane's expected verdict is now pinned as a literal, Claude's
  score is pinned to prove it was computed rather than defaulted, and the pair
  of controls is recorded: the same break is RED under the new assertion and
  GREEN under the old one.
- **The live install assertion had the same hole.** The runbook's keys-only
  `jq` check is replaced by `scripts/tog-2922-prerequisite-refresh-gate.mjs`,
  which requires a non-`unknown` state *and* a non-null score for
  `cliproxy-claude`, `cliproxy-codex` and `cliproxy-opencode-go`, and exactly
  `unknown` for `cliproxy-kimi`. The gate is unit-tested against the refresh
  shapes the old check accepted, so the install gate and the CI gate cannot
  drift apart.
- **The 0.4.4 package shipped no operator runbook.** `files` still named
  `docs/operator/TOG-2922-v0.4.3-pace-ordering.md` after the rename to v0.4.4;
  npm does not error on a `files` entry that matches nothing, it just ships one
  file fewer, so the tarball reproduced byte-for-byte while missing the
  document the operator installs from. The runbook now has a version-stable
  name, and a test asserts every `files` entry exists and that every script the
  runbook tells the operator to run is actually packaged.

## [0.4.4] - 2026-09-16

Supersedes the never-tagged 0.4.3 candidate, which was rejected in review: it
gated pace *evaluation* on the same flag as pace *steering*, so the prerequisite
config landed `source.pace` but produced zero verdicts. 0.4.3 was never tagged or
published; no installation carries it.

Compatibility: drop-in over 0.4.2 while `capacityRouting.paceOrdering` remains
false (the default). Before enabling it, add a `pace` definition to every live
capacity source. Health-only sources may use `windows: []`; they emit an explicit,
fail-neutral `unknown` verdict until utilization telemetry appears. The flag is a
separate later one-key change and can be rolled back independently.

### Changed

- **A refresh evaluates configured lane pace even while `paceOrdering` is off
  (TOG-2922).** Evaluation is now keyed on a source having a `pace` block, not on
  the steering flag, so the prerequisite config write warms real verdicts and the
  later enable is genuinely one-key and observable beforehand. Pace rides the same
  capacity response, so no extra fetch is made and a malformed lane document stays
  fail-neutral. Steering remains gated in two independent places — the verdicts
  passed into selection and `paceActive` inside the engine — and a regression test
  pins both halves: verdicts present, selection unmoved.

- **Pace ordering is release-ready for the live four-source router (TOG-2922).**
  The manifest accepts `capacityRouting.paceOrdering` and source `pace` blocks,
  refreshes persist non-empty lane verdicts, and selection orders only the
  already-eligible survivor pool toward the furthest-behind lane. Health-only
  lane documents are retained as explicit `unknown` verdicts instead of having
  their pace block discarded, so telemetry gaps remain visible and fail-neutral.

- **CI merges three redundant jobs into one (TOG-2547).** `typecheck, test,
  build`, `the packed tarball is installable` and `version and changelog` each
  paid their own checkout/setup-node/npm-ci for 7-30s of real work, and GitHub
  bills per job rounded up to the nearest minute — three sub-minute jobs billed
  three minutes apiece for no functional reason. They are now one job,
  `typecheck, test, build, package, version`, in the same fast-fail-first
  order; `secret scan` stays separate because it needs its own full-history
  checkout. No check was removed. This change is queued as
  `docs/operator/tog-2547-ci-job-merge.patch` per
  [`docs/decisions/0008`](docs/decisions/0008-workflow-files-are-operator-applied.md)
  — no agent can push `.github/workflows/`, so `ci.yml` itself is unchanged
  until an operator applies the patch. See
  [`docs/decisions/0011`](docs/decisions/0011-ci-jobs-merge-for-per-job-billing.md).

### Fixed

- **Decision telemetry is no longer a 200-record ring buffer (TOG-1038).** Every
  decision now appends to a namespaced database table instead of rewriting
  `plugin_state` and silently discarding the oldest row. The table is indexed by
  company and timestamp and prunes records older than 90 days at worker startup.
  Existing installations gain the table through the bundled migration; each
  company's old bounded state row is copied into it on the company's next invoke,
  left untouched as recovery data, and no longer written. This release adds three
  database capabilities, so the stock host's ordinary upgrade endpoint is not a
  valid transition: use the reviewed capability-approval install path documented
  in `docs/OPERATIONS.md` or the host stops the old worker and rejects the upgrade.

## [0.4.2] - 2026-09-05

Compatibility: drop-in over 0.4.1. No config migration is required and no existing
config becomes invalid. `capacityRouting.unknownTelemetry` gains a third value,
`fail-open`, and **the default changes from `fail-closed` to `fail-open`**. A company
that has set the field explicitly keeps exactly its current behavior; a company that
never set it changes behavior, which is the point of this release.

This only affects companies running `capacityRouting.enabled: true` with
`mode: "enforce"`. Capacity routing is still disabled by default, so a company that
has not opted in is unaffected either way.

To keep the old strict posture, set `capacityRouting.unknownTelemetry: "fail-closed"`
explicitly. Be aware that is the configuration that produced the outage below.

### Fixed

- **Enforce mode denied service when capacity telemetry was absent or unparseable
  (TOG-1040).** Under `capacityMode: "enforce"` the router returned `no-eligible-model`
  — no model at all — rather than falling back to the static routing policy. 15 such
  records accumulated on the live v0.4.0 fleet, 9 of them on 2026-09-05, all with
  `capacityLane: null` and `capacityPosture: "not-evaluated"`. This was never lane
  exhaustion: `fallbackUsed` was `false` in all 200 records, so the fallback path had
  never once fired.

  There were two distinct fail-closed paths, matching the two shapes in the log:

  1. `src/engine/select.ts` refused outright when telemetry was globally unavailable.
     These are the records carrying `capacity telemetry unavailable: capacity payload
     carried no recognizable telemetry records`.
  2. `src/engine/select.ts` also refused when *any* qualified model lacked usable
     evidence — even when another qualified model had healthy evidence and was ready
     to serve. One uncovered model vetoed every covered one. These are the records
     that reported `capacity telemetry available` and still selected nothing.

  Both now fail open by default: absence of a capacity signal is not a signal that
  capacity is gone. A model with missing or unknown evidence sorts last but stays
  selectable, and an unparseable payload degrades to the static routing policy.

### Changed

- `capacityRouting.unknownTelemetry` accepts `fail-open` (new default), `exclude-lane`,
  and `fail-closed`. An unrecognized value now resolves to `fail-open` rather than
  `fail-closed`, so a typo degrades routing instead of halting it.

### Added

- `capacity.degraded` on the routing decision and `capacityDegraded` on the decision
  record: `true` when the router served without capacity awareness because telemetry
  was absent. A telemetry outage stays loud and countable without denying service, and
  the trace carries an explicit `WARNING` line.

### Safety

- Fail-open relaxes **absence** only. Evidence that positively reports `unavailable` or
  `exhausted` still excludes that model under every policy, so the capacity-enforcement
  guarantees closed in TOG-972 are intact: pins, stickiness, and the configured fallback
  still cannot cross a lane that is reporting exhaustion. Covered evidence continues to
  outrank uncovered evidence, so a healthy lane is still preferred whenever one is known.

- An explicit `exhausted`/`unavailable` health is honoured even when the producer sends
  no utilization number with it (TOG-1062, found in review). The capacity normalizer only
  reports `telemetryAvailable` when a utilization value is present, so a lane reporting
  `status: "exhausted"` with a null percentage — what a quota API typically returns once
  there is no quota left to express as a fraction — would otherwise have been read as
  *absence* and served under `fail-open`. The posture check now tests the explicit health
  signal before the absence check.

- The same precedence now applies at the **capacity refresh gate**, one layer earlier
  (TOG-1064, found merging this PR). That gate decides whether a snapshot is persisted at
  all, and it used the pre-TOG-1062 predicate: a status-only `exhausted` lane made the
  whole refresh `capacity-refresh-incomplete`, so the evidence was never written to state.
  Because `invoke` reads *stored* capacity, the engine then saw absence rather than
  exhaustion and served the lane anyway — the engine-level fix above could not save it,
  since the engine never received the evidence. Both layers now agree that an explicit
  `exhausted`/`unavailable` health is a positive signal.

## [0.4.1] - 2026-09-05

Compatibility: drop-in over 0.4.0. No config migration is required and no existing
config becomes invalid. Nothing changes for a company that edits nothing — in
particular the default request timeout is still 25s. Both fixes below are things
0.4.0 got *wrong*, not new capability, so an operator on 0.4.0 should take this.

Caller-visible contract change, and the only reason to read further before
upgrading: `response.content` may now be an empty array on a `completed` outcome.
A caller that assumed at least one content block on success must handle that. It
was previously impossible only because the router turned that reply into an error.

### Fixed

- **The 25s timeout ceiling discarded finished work (TOG-1035).** `requestTimeoutMs`
  was clamped to a 25s maximum, and v1 invokes once with no retry, so any generation
  that ran longer was abandoned. In the first hour of the enforce-mode trial this
  killed 20 of 32 `implementation` calls to `cliproxy/glm-5.3-flash` — every one at
  exactly 25.0s — while OmniRoute's call log showed those same completions arriving
  upstream at ~27s. The router had hung up on work that was done and paid for. The
  configurable ceiling is now 300s.

  The **default is deliberately still 25s**. The schema's `default` used to be
  spelled `MAX_REQUEST_TIMEOUT_MS`, so raising the ceiling would have silently moved
  every unconfigured company to 300s; the default is now its own pinned constant and
  a test holds it there. Raising the wall is strictly opt-in.

- **An empty reply from a reasoning model was blamed on the upstream (TOG-1035).** A
  model that spends its whole output budget on hidden thinking tokens returns a
  well-formed success carrying nothing readable. The router reported
  `invalid-upstream-response`, which hid a real billed generation and implicated the
  wrong component; it accounted for 5 of the 50 trial calls, and `minimax-m3` also
  leaks `<think>` into `content`. Such a reply now normalizes as a completion with
  `stopReason: max-tokens`. A stop reason the upstream actually asserted — `refusal`,
  `content-filter` — is preserved, since that is the more specific explanation for
  the emptiness. Structurally malformed envelopes still fail as before.

### Added

- **Per-model `models[].requestTimeoutMs`.** Overrides `upstream.requestTimeoutMs`
  when that model is selected; omit it to inherit. One ceiling cannot suit both a
  reasoning model that needs minutes and a fast model that should fail quickly. The
  value is clamped in the transport rather than trusted from config, because
  `getConfigSchema()` is form metadata that validates nothing at runtime, and it is
  keyed off the *selected* model so it follows capacity-enforce substitutions.

## [0.4.0] - 2026-09-04

Version note: this line was briefly staged as `0.3.0`. That number was already taken by the
invocation-health line (`tog-534-private-release-0-3-0`, built 2026-09-02 and staged on the
host), so two disjoint builds claimed one version. Router v2 vacated the collision and takes
`0.4.0`; `0.3.0` and `0.3.1` belong to the invocation line. Never resolve a router artifact by
version string alone — check `dist/` for the feature markers of the line you mean.

### Added

- **Sanitized model-usage evidence (TOG-943/972).** Capacity sources associate health,
  utilization, and reset facts with exact opaque model IDs. Source IDs and lane labels are
  audit labels only; the plugin neither chooses nor reports the provider/account that serves
  inference. Catalogue presence is not health evidence.
- **Separate refresh semantics.** `refresh-capacity` performs one bounded, host-managed GET
  per configured source and stores a company-scoped snapshot only when every refresh result
  is valid. Canonical `invoke` performs zero telemetry GETs and still attempts inference once.

### Changed

- Replaced the selection-only product with the compatible-upstream v1
  `select -> invoke -> normalize -> record` operation and exact OpenAI Chat Completions- and
  Anthropic Messages-compatible adapters.
- Capacity is disabled by default and shadow-first. Shadow records an evidence-aware model
  alternative while preserving v1 selection. Enforce may change only the opaque model ID,
  after capability, context, budget halt, and quality gates. Pins, stickiness, and fallback
  use the same strict evidence predicate and cannot cross unavailable or unknown evidence.

### Security and safety

- Capacity reads require absolute public HTTPS URLs, closed Paperclip secret references,
  manual redirects, JSON with identity encoding, bounded time and size, one request, no retry,
  and router-authored failure codes. Failed refreshes do not overwrite a valid snapshot.
- Enforce defaults to `fail-closed`. Explicit health and window health combine conservatively;
  reset-only fields never suppress valid utilization, and utilization stays paired with its reset.
- No capacity output contains credentials, raw bodies, URLs, deployment provider/account, or
  unverified serving identity. Transport failure never causes replay or model reselection.

### Promotion policy

Promotion is an operator decision, not an automatic gate. Require TOG-901/916 observations,
TOG-251 measurements, fresh coverage for every affected model, a clean representative shadow
window, and an outage rehearsal proving fail-closed behavior. This staged version authorizes
neither a public release nor a live installation. Disable `capacityRouting` to restore v1.

### Compatibility

- Existing current-main compatible-upstream configs retain v1 behavior because capacity is
  optional and disabled by default. Historical selection-only v0.2.7 configs still require
  migration to the compatible-upstream schema.

## [0.2.7] - 2026-08-25

### Changed

- **The Claude provider allowlist now includes `cliproxy` by owner-approved policy
  widening (TOG-502).** This is not a bug fix: the owner answered TOG-424 with
  `admit`, TOG-360 records that policy, and TOG-352 verified the CLIProxy lane
  live through OmniRoute before this code change. `CLAUDE_PROVIDER_ALLOWLIST`
  therefore widens from `teamclaude` to `teamclaude` plus `cliproxy`.

  `providers.claudeFamilyProvider` still selects exactly one entry from that
  code list. It can choose either approved provider, case-insensitively, but it
  cannot combine them or admit a provider such as `openrouter`; values outside
  the list remain a config-validation error and fail closed in the engine.
  Removing `cliproxy` would reverse the stated owner preference and requires a
  new owner decision rather than an ordinary rollback.

### Fixed

- **The documented install path had rotted three releases behind, and the
  rollback floor was understating itself by three (TOG-156).** The README and
  `docs/OPERATIONS.md` told an operator to `gh release download v0.2.3` while
  the repo shipped `0.2.6`. Those commands are copy-pasted verbatim onto a live
  instance, so a stale version there is not a typo — it installs an older build.

  `tests/docs-install-version.spec.ts` now pins every *executable* install
  command to `package.json`, so the next bump fails the suite until the docs
  move with it. Its patterns are anchored on the command shape rather than on a
  bare `vX.Y.Z`, so prose that names an old version deliberately is left alone,
  and a vacuity check asserts the commands are still present at all — the guard
  cannot pass by matching nothing.

  Separately, the stated floor was wrong. It read `v0.2.3`, but `v0.2.4`
  (`models[].providers` outranking the id's routing prefix, TOG-149), `v0.2.5`
  (a bare Claude id read as proof of a teamclaude route, TOG-294) and `v0.2.6`
  (the fallback judged by gates that never ran, TOG-248) each closed a further
  way around owner rule 1. The floor is `v0.2.6`, which is also the newest
  release — so rollback is not currently an available remedy, and both documents
  now say that outright instead of implying an earlier safe version exists.
  Nothing checks the floor list; both places say so and say to update it by hand.

### Security

- **A failed gitleaks *download* was being reported as a failed *secret scan*,
  and nothing verified the binary (TOG-488).** The install was
  `curl -sSfL … | tar -xz`. When curl failed, tar read an empty stream, printed
  `Error is not recoverable` and the step exited 2 — which GitHub renders as a
  red check named `secret scan`, the identical signal to a committed credential.
  It happened on `501c5b7` (PR #22): the job died 5s in, where a green run of the
  same job needs 8s to check out, install and run both scans; re-pushing the same
  tree with one unrelated commit turned it green with no change to any scanned
  content. The cost was never the red check — it was that the only available
  response to it was "re-run and see", which is the one habit a secret scanner
  must never teach. Separately, CI was piping an unverified executable off the
  network into `/usr/local/bin` and running it across the whole repository, in
  the one job whose entire value is being trustworthy about credentials.

  The install now downloads to a file with retries, checks it against the
  published SHA256 before extracting, stages it in `RUNNER_TEMP` rather than the
  tree the next step scans, and gives each failure its own `::error::` naming
  what actually went wrong. All three paths were exercised against the real
  release: happy installs 8.21.2 and exits 0; a 404 URL exits 1 with
  "this is a DOWNLOAD failure, not a secret scan finding"; a wrong digest exits 1
  with "Refusing to run an unverified scanner" and extracts nothing.

  The same patch **wires in `scripts/gitleaks-selftest.sh`**, which has been
  asserting nothing since it shipped — see the entry below.

  > **Applied by an operator, not by this PR.** No agent in this company can push
  > `.github/workflows/`, and that is deliberate — see
  > [`docs/decisions/0008`](docs/decisions/0008-workflow-files-are-operator-applied.md).
  > The change is checked in as `docs/operator/tog-488-ci-secret-scan.patch` and
  > `npm run check:workflows` is red until a human applies it. Until then, treat
  > the `secret scan` job's green as unverified and its red as unexplained.

- **The secret scanner was printing the credential it caught into the CI log
  (TOG-227).** Both custom rules in `.gitleaks.toml` put their capture group on
  the *key name* rather than the value. gitleaks treats capture group 1 as "the
  secret" — it is what `--redact` replaces and what `[allowlist] regexes` are
  matched against — so `--redact` suppressed the word `ANTHROPIC` and printed
  the key. Reproduced: a file containing `ANTHROPIC_API_KEY = "sk-ant-api03-…"`
  renders in the scan output as `REDACTED_API_KEY = "sk-ant-api03-…"`.

  That path only executes when a real key is actually present — the one case
  where being wrong costs something, and the one case no green build ever
  exercises. Both rules now capture the value, and `omniroute-credential`'s
  value class excludes quotes so the captured secret is the credential rather
  than the credential with the source file's punctuation attached.

  Fixed alongside it: allowlist entries were unanchored, so exempting the
  fixture `sk-live-not-a-reference` silently exempted
  `sk-live-not-a-reference<real key>` too. All entries are now `^…$`, which is
  what the "exempted by exact value" comment already claimed. The three
  name-based entries (`apiKeySecretRef`, `OMNIROUTE_API_KEY`,
  `ANTHROPIC_API_KEY`) are removed: they were matched against the captured
  secret, never against the variable name, so they had never had any effect.

### Added

- **`npm run preflight:tog473` — the broker's mapping guard is now graded
  against the live catalogue instead of hand-written strings (TOG-473).**
  `mappings.create` is the only broker verb that moves traffic, and its safety
  argument rests on one empirical claim: the family regex blocks every
  Claude-bearing id OmniRoute serves. The broker's own unit tests assert that
  against literals — the same blind spot that let TOG-237 ship. The script
  imports the guard from the broker (so a copied regex cannot certify itself)
  and runs it over the real corpus: 350/350 Claude-bearing ids blocked, 0
  escaped, all 52 planned TOG-178 mappings still permitted. A harness failure
  exits 2, never 0 and never 1, so a broken checker cannot read as a clean
  guard.

- **`npm run check:workflows` — the handoff gate for changes no agent can push
  (TOG-488).** Three gates: every queued `docs/operator/*.patch` still applies to
  the current tree; every pinned scanner digest still matches the publisher's own
  checksums file; and every script in `scripts/` is reachable from something that
  runs it — `package.json`, a workflow, or another script.

  The third gate is the one that earns the script. A test that runs nowhere and a
  test that passes are indistinguishable from outside, which is how
  `gitleaks-selftest.sh` shipped and then asserted nothing. It reports a script
  wired up *only* inside an unapplied patch as a failure rather than a pass,
  because queued is not running. Mutation-tested: drifting `ci.yml` under the
  patch fails gate 1, corrupting the pinned digest fails gate 2, and the gate 3
  case is live right now.

  Its first draft got gate 3 wrong in the most instructive way — it credited any
  textual mention, so its own comments naming `gitleaks-selftest.sh` marked that
  script reachable, and the gate reported PASS on the exact defect it was written
  to catch. Comments are now stripped before a caller counts, and the file
  excludes itself as a caller.

  Gate 3 grades what git *tracks*, not what is sitting in `scripts/`. Agents
  share a checkout, so that directory routinely holds a neighbour's work in
  progress — an uncommitted script from another issue turned this gate red on a
  branch that had never heard of it. A gate whose colour depends on who else is
  working is not a gate. Untracked scripts are listed as a note and graded the
  moment they land. If the tracked listing comes back empty while `scripts/` is
  not, the run exits **2** rather than reporting a gate with no rows, because an
  empty gate and a passing one print the same thing.

  Deliberately not part of `npm run verify`: it is legitimately red while a patch
  is pending, and a check that is normally red teaches everyone to ignore it.
  Like `check:pin`, it is run at the handoff.

- **`npm run check:pin` — the version an operator is handed is now checked by a
  script, not by a run that re-improvises it (TOG-227).** Nothing in `verify`
  or `verify:host` looks at the *published release asset*, which is the only
  artifact an operator actually installs. Three separate cards reached the
  owner's queue carrying a pin that did not hold: `v0.1.1` named a tag with no
  tarball behind it, `v0.2.3` named a version the runbook itself had already
  marked unsafe, and `v0.2.4` was four `src/` commits stale by the time it was
  read. All three are mechanical comparisons.

  `scripts/release-pin-check.mjs` runs seven gates against a tag: it resolves;
  `package.json` and `CHANGELOG.md` **at that tag** agree with it; a published
  non-draft release exists with exactly one `.tgz`; the asset downloads and
  matches `--expect-sha256`; the asset's `dist/*.js` are **byte-identical to a
  fresh build of the working tree**; and `git diff <tag>..HEAD -- src` is empty.

  Gate 6 is the one no human does by hand, and it is what collapses "the tests
  passed on `main`" and "the operator installs the tarball" into one claim.
  Gate 7 is permitted to fail; when it does the answer is to cut a new tag
  rather than reword the runbook, and the failure says so.

  The GitHub token comes from the repo's own git credential helper, so there is
  nothing to configure. Network gates **fail** rather than skip when they cannot
  run — a pin that could not be checked is precisely the case this exists to
  catch. `--for-card` prints a paste-ready block and refuses to print it if any
  gate failed *or skipped*; `--offline` is rejected alongside it.

  Deliberately not part of `npm run verify`: at commit time the release for the
  version under development does not exist, so folding it in would fail every
  build and train everyone to ignore it. See `docs/PROCESS.md`, "Handing a
  version to an operator".

- **`scripts/gitleaks-selftest.sh` — a test for the secret scanner itself
  (TOG-227).** `gitleaks dir .` proves the repository is clean under the current
  config and says nothing about whether that config still detects anything. A
  defanged rule and a clean repository produce identical output, so green is
  also what a broken scanner looks like — which is how both defects above
  survived.

  > **Not yet wired into CI**, and therefore asserting nothing — this header's
  > original claim that it was "run in the same CI job as the scan" was never
  > true. It belongs as a step in the `secret-scan` job, ahead of the two scans,
  > reusing the gitleaks binary that job already installs. The push was
  > rejected: `refusing to allow a GitHub App to create or update workflow
  > .github/workflows/ci.yml without workflows permission`.
  >
  > "Tracked separately" resolved to **TOG-488**, and the answer is that the
  > scope is *not* coming: the boundary is deliberate and stays
  > ([`docs/decisions/0008`](docs/decisions/0008-workflow-files-are-operator-applied.md)).
  > The wiring is queued instead as `docs/operator/tog-488-ci-secret-scan.patch`
  > for a human to apply. Until they do, run it by hand —
  > `scripts/gitleaks-selftest.sh "$(command -v gitleaks)"` — and treat the
  > secret-scan job's green as unverified. `npm run check:workflows` now fails
  > for exactly this reason rather than leaving it to a note in a changelog.

  Ten assertions: each rule fires on a realistic key; each allowlist entry
  exempts its fixture and *not* that fixture with a suffix appended; and
  `--redact` suppresses the value while leaving the variable name visible.
  Mutation-tested against all three defects — reinstating the key-name capture
  group fails 3 assertions, un-anchoring an allowlist entry fails 1, widening
  the value class back to `\S` fails 1.

  Two notes for anyone adding a probe. Values must look like real credentials:
  gitleaks' default allowlist discards low-entropy matches, so an `"AAAA…"`
  probe reports zero findings and reads as a broken rule. And a probe's name and
  value are held in separate variables and joined at runtime, because a
  credential-shaped literal in this file would be flagged by the very scan it
  tests — and exempting the probes is not a way out, since they run under the
  same config and would stop firing.

### Fixed

- **`main` was red.** `322de62` (TOG-152, PR #19) added
  `OMNIROUTE_API_KEY: "sk-not-a-real-key"` to `tests/tog178-preflight.spec.ts`
  — a deliberate placeholder, needed so the test can prove the preflight exits
  `2` on an unreachable catalogue instead of reading as a clean spec. The
  secret scan has failed on every commit since. It is now exempted by exact
  anchored value.

## [0.2.6] - 2026-08-24

### Fixed

- **`verify:host` stopped claiming an install it had only half-checked
  (TOG-232).** Raised by the TOG-228 QA review, question 6. The script really
  did run the host's own validators for install steps 3–4, and that was the
  whole of its coverage — `plugin-loader.ts` runs three further gates before it
  writes a plugin row, so a manifest could pass `npm run verify:host` and still
  be rejected by a real install. All three now run:

  - **step 5**, `capabilityValidator.validateManifestCapabilities` — declared
    features must be covered by declared capabilities. This is the gate that
    decides whether TOG-228's least-privilege trim went one capability too far.
    It is *not* redundant with the schema check above it: the Zod schema carries
    the same rule for top-level feature blocks like `tools`, but has none for
    `ui.slots` or `launchers`, so a `dashboardWidget` slot missing
    `ui.dashboardWidget.register` parses clean and is caught only here.
  - **step 5b**, page-route path collision. This plugin declares no page routes,
    so the half that can be checked offline — duplicates within one manifest —
    has nothing to reject today. A synthetic probe keeps the detector proven
    live rather than merely present. The other half compares against
    `registry.listInstalled()` and needs a running instance; it prints `SKIP`.
  - **step 6**, `getMinimumHostVersion` vs the running server. Also a no-op for
    this manifest today, and it says so instead of passing silently.

  With `PAPERCLIP_HOST` pointed at a checkout root (auto-detected at `/app`),
  step 5 runs the host's compiled `plugin-capability-validator.js` — the real
  `FEATURE_CAPABILITIES` table. Without one, mirrored implementations run and
  label every line `[MIRROR]`; when a host *is* reachable the mirror is
  re-derived against it entry by entry and any disagreement fails the run, so
  the copy cannot rot through a release unnoticed.

- **The apiVersion check no longer disappears when you aim the script more
  precisely (TOG-232).** It read `PLUGIN_API_VERSION` off whatever
  `PAPERCLIP_SHARED` named and did nothing at all — no PASS, no FAIL, no line —
  when the export was absent. The pointer the README documents,
  `packages/shared/dist/validators/plugin.js`, is exactly such a module: it
  carries the schema, while the constant lives in `dist/constants.js` beside it.
  So the closer you aimed at a real host, the more of the check switched itself
  off. The constant is now resolved through the entry, its siblings, the host
  checkout and the SDK in turn; a genuine miss prints `SKIP`. Where
  `PAPERCLIP_HOST` is set, the host's `getSupportedVersions()` — the gate
  install step 4 actually applies, and a set rather than a single constant —
  runs as well.

- **Skipped checks are part of the verdict.** The summary line now reports them
  next to the failure count, because "all host-side checks passed" while three
  of them never ran is the sentence this script exists to make unwritable.

- **The fallback stopped being judged by gates that never ran (TOG-248, owner
  rule 1).** Found by the post-merge review of TOG-237/PR #6, which asked for a
  route the union in `isClaudeFamily` did not close. This is not that route —
  the classifier holds — it is one layer further out: the fallback never asked
  the classifier anything.

  `routing.fallbackModelId` decided whether it was allowed to run by SEARCHING
  the rejection list for an entry naming it with a non-negotiable stage
  (`not-in-table`, `claude-block`, `provider-not-permitted`, `quota-gate`). That
  is evidence-based, and the evidence only exists if the candidate loop reached
  the gate. The loop rejects on **capability** and **context window** first and
  `continue`s, so a fallback that failed one of those was never asked the Claude
  question at all — and the *absence* of a rejection was read as clearance.

  One descriptor field the caller controls was enough:

  ```
  descriptor: { requiredContextTokens: 10_000_000 }
  config:     { routing.fallbackModelId: "claude-opus-5",
                providers.permitted: ["opencode-go", "openrouter"] }

  v0.2.5:     outcome "selected", modelId "claude-opus-5", fallbackUsed true
  ```

  on a company where `teamclaude` was not a permitted provider, with the trace
  asserting *"it clears every hard constraint"*. The same descriptor also
  carried `oc/claude-opus-5` past the routing-prefix rule (TOG-149), carried a
  bare Claude id past an unarmed instance (TOG-294), and carried Claude work
  through a **paused** pooled quota (TOG-228). Three defences that all live
  inside or below the Claude block, and one upstream `continue` that meant none
  of them ran.

  The fallback now **asks** the gates instead of looking for their footprints:
  `nonNegotiableRejectionFor` evaluates the four hard constraints directly
  against the model, and the candidate loop calls the same function, so the two
  cannot drift. A gate that never ran returns its verdict on demand. The refusal
  is also recorded in `rejections`, not only in the trace, so the decision log
  still carries it when the loop never got far enough to say so.

  The pin and stickiness were checked and were never exposed — both are judged
  against `qualified`, which a model rejected upstream never enters. There is
  now a test asserting that rather than a claim.

  Compatibility: no config change. A fallback that was legitimately usable is
  still usable, including past the estimates it exists to override (quality
  floor, tier ceiling, a capability the caller only thinks it needs).

### Changed

- **The mislabel error stopped describing a pattern it outgrew (TOG-248).** The
  validator told operators that `aug/opus4.7` "has a Claude/Anthropic id" — an
  id containing neither word. The sentence was accurate when the pattern was
  `claude|anthropic`; TOG-149 widened it to the family names and the message did
  not follow. Both the validator error and the schema's `family` description now
  quote the pattern that actually classified the id, so an operator can see why
  their row was refused instead of being told something visibly untrue about it.

## [0.2.5] - 2026-08-24

### Fixed

- **A bare Claude id is no longer trusted to mean "teamclaude" (TOG-294, owner
  rule 1).** v0.2.4 refused a Claude id carrying a non-teamclaude routing prefix
  (`oc/claude-opus-5`) and permitted a **bare** one (`claude-sonnet-5`)
  unconditionally, on the stated ground that a bare id "is resolved by a combo".
  That ground was never checked. Measured against the live router:

  - `GET /api/v1/models` returns **1,438** ids, of which **zero** are bare, and
    **`teamclaude/*` is empty** — there is no teamclaude combo, because TOG-153
    is not deployed.
  - `POST /v1/messages` with `{"model": "claude-sonnet-5"}` nonetheless returned
    **200**, echoing `"model": "anthropic/claude-sonnet-5"` — an id that is
    *also* absent from the catalogue. Same for `claude-opus-5` and
    `claude-fable-5`. `claude-haiku-4-5-20251001` returned 400. Whether an
    alias table or a passthrough onto the live `anthropic` provider rewrote
    the id is still open — it needs a management-token read of the alias map
    — and the plugin's behaviour does not depend on the answer, because it
    refuses the bare id either way.

  An unlisted bare Claude id therefore does not fail closed at the router; it is
  silently rewritten onto a non-teamclaude Anthropic route and served. That is
  owner rule 1 broken by **the exact id form owner rule 3 mandates**, which is
  why it cannot be fixed by banning bare ids.

  The plugin cannot fix the router, so it refuses to walk into it. A bare Claude
  id is now permitted only when `MODEL_ROUTER_CLAUDE_COMBO_ARMED=1` declares the
  teamclaude combos deployed. Default off, and off blocks the model at
  `claude-block` rather than routing it somewhere unverified.

  The prior `claude-block` trace made this worse: it advised *"name the bare
  model id and let an OmniRoute combo resolve it"*, which moved an operator off
  a **blocked** leak and onto a **silent** one. That advice is now conditional on
  the lane being armed, and the unarmed trace names the env var and the deploy
  step instead.

### Changed

- **`claude-lane-preflight.sh` leads with a provider probe, not the
  catalogue (TOG-294).** An earlier cut of this script inferred "teamclaude is not a
  registered provider" from "`teamclaude/*` is absent from the catalogue". A
  read-only check on the routing scope — `GET /api/v1/providers/{provider}/
  models`, which answers 200 for a known provider and 400 for an unknown one —
  shows that inference does not hold:

  | provider | probe | models in catalogue |
  |---|---|---|
  | `anthropic` | 200 | 0 |
  | `claude` | 200 | 0 |
  | `cc` | 200 | 0 |
  | `oc` | 200 | 166 |
  | `openrouter` | 200 | 1012 |
  | `teamclaude` | **400** | 0 |

  `anthropic` is a **registered provider contributing zero ids to the
  catalogue**. So catalogue absence never meant "not routable", it meant "no
  synced model list" — which is why an unlisted `anthropic/claude-sonnet-5` was
  served. **Catalogue membership is not a containment boundary and the plugin no
  longer treats it as one.**

  For teamclaude the old check would eventually have produced a **false
  negative**: once the provider is registered the lane can be live while its
  catalogue is still empty, and a catalogue-only check would report `NOT ARMED`
  forever, blocking a lane that had been deployed correctly. The result is now
  three-state — provider unknown (`NOT ARMED`, TOG-153 outstanding), provider
  registered but catalogue empty (`NOT ARMED`, insufficient evidence, distinct
  next step), both signals present (`ARMED IS SUPPORTED`). Still read-only, still
  no completion; it is two GETs instead of one.

  Live result is unchanged — `teamclaude` probes **400**, so `NOT ARMED`, exit 1.
  That claim is now measured rather than inferred.

### Added

- **`scripts/claude-lane-preflight.sh`** — answers "is it honest to arm this?"
  with two **read-only** GETs — a provider probe and `GET /api/v1/models`;
  exits non-zero while the teamclaude lane is unproven (see **Changed**
  above for the three-state result). It deliberately sends **no completion**: TOG-294 was
  found because a verify script sent three live Claude completions off-teamclaude
  while the owner has that lane disabled, and a preflight whose job is to check
  that a lane is safe must not use the lane to find out. Needs only a
  routing-scope key, so the arming claim is auditable by anyone.

### Compatibility

- **No config change, and none is possible.** `claudeComboArmed` is env-derived
  only; there is deliberately no `providers.*` field for it, and
  `additionalProperties: false` turns an attempt to set one into a write-time
  error. Phase 4 installs this plugin into companies whose config the owner does
  not review, so an installee must not be able to assert facts about the owner's
  router.
- **Existing installs lose the Claude lane until the operator arms it.** That is
  intended and is the point of the release: on this instance the lane was
  resolving to a non-teamclaude Anthropic route, so what is lost is a route the
  owner had disabled. Run the preflight, deploy TOG-153, then arm.

## [0.2.4] - 2026-08-24

### Fixed

- **The model id's routing prefix outranks `models[].providers` (TOG-149,
  owner decision `rule1_scope: teamclaude_only`).** v0.2.3 moved *which models
  are Claude* into code but left *who serves a Claude model* resting on
  `models[].providers` — the same kind of company-supplied claim TOG-237 had
  just removed one layer down. The shortest reproduction on v0.2.3:

  ```json
  { "id": "oc/claude-opus-5", "family": "claude", "providers": ["teamclaude"] }
  ```

  cleared every gate with an **empty** `claude-block` rejection list, and when
  pinned returned `outcome: "selected"` with `honored: true`. Paperclip would
  then name `oc/claude-opus-5` to OmniRoute, which routes on the `oc/` prefix —
  so opencode serves Claude. The `providers` array is a claim *about* the
  destination; the prefix *is* the destination, and the gate read the claim
  while ignoring the instruction. A Claude id may now carry no prefix (the
  rule-3 form an OmniRoute combo resolves) or a prefix that is itself a
  sanctioned Claude destination; anything else is refused, and the rejection
  names the prefix so an operator does not go and edit the wrong field.

  Deliberately not conditioned on `claudePaygEnabled`: enabling PAYG is the
  owner adding a second leg to a **combo**, and never makes it correct for
  Paperclip to hardcode a provider into a model id.

- **Claude models named by family only are now recognised (TOG-149).** The
  Claude id pattern was `claude|anthropic`. Measured against the live OmniRoute
  catalogue on 2026-08-24 (1,438 ids), that **missed 15 real Claude routes** —
  `aug/opus4.7`, `aug/sonnet5-high`, `aug/haiku4.5`, `aug/fable-5` and siblings
  name the model by family and contain neither substring, so `idNamesClaude`
  returned false, the Claude block was never entered, and auggie served Claude.
  The operator-run combo CLI has refused these since TOG-151; the policy layer
  was selecting them. **The two layers disagreeing was itself the defect.** The
  pattern is now the CLI's suspicion list,
  `claude|anthropic|opus|sonnet|haiku|fable|prism`, measured before widening:
  across all 1,438 live ids it introduces zero matches that are not Claude or
  Claude-blended.

### Compatibility

No config migration. Both changes only ever **refuse** a route that previously
resolved, so a company whose model table names bare ids (every shipped fixture)
is unaffected. A company that had named a prefixed Claude id was relying on the
defect and must switch to the bare id.

## [0.2.3] - 2026-08-23

### Fixed

- **The Claude block's destination is code, not configuration (TOG-237
  follow-up).** v0.2.2 moved *which models are Claude* into code and left the
  two questions either side of it in the company's config row, and both decide
  the same outcome. `providers.claudeFamilyProvider` was a free-form string:
  setting it to `"openrouter"` did not disable the Claude block, it **aimed**
  it, and a Claude model that teamclaude cannot serve came back
  `outcome: "selected"` with an empty `rejections` array and no trace line —
  while the message that did print read *"may only be served by openrouter"*,
  stating the misconfiguration back as though it were owner rule 1. Reproduced
  on v0.2.2 before the fix. The permitted providers are now
  `CLAUDE_PROVIDER_ALLOWLIST` in `src/constants.ts`; `claudeFamilyProvider`
  selects from that list and a value outside it intersects to nothing, so the
  model is blocked and the failure direction is a refusal.

- **Claude PAYG is an owner switch, not a company one (same root cause).**
  `providers.claudePaygEnabled: true` skipped the Claude block outright and
  produced a *warning*. Owner rule 1 keeps Claude PAYG disabled until the
  **owner** enables it, and a company config row is not the owner — which
  matters precisely because this plugin is built to install into other
  companies, whose configuration the owner never reviews. The flag now requires
  the instance-level `MODEL_ROUTER_CLAUDE_PAYG_UNLOCK=1`: without it
  `resolveConfig` forces the value to `false` (so a value that reached the row
  by a direct write, a migration or an older schema is neutralised rather than
  trusted) and `onValidateConfig` refuses the write instead of warning.

### Compatibility

- **A company that had set `claudePaygEnabled: true` loses it** unless the
  instance sets `MODEL_ROUTER_CLAUDE_PAYG_UNLOCK=1`. Claude models served only
  by non-teamclaude providers will be `claude-block` rejected. This is the
  intended direction of owner rule 1 and it fails closed, but it is a behaviour
  change on upgrade, not a silent no-op. The shipped `company-b` fixture is
  exactly such a config; the acceptance rehearsal sets the unlock and asserts
  the locked case separately.
- **`claudeFamilyProvider` is now an `enum`, not a free string.** A stored value
  other than `"teamclaude"` is refused by the host's own Ajv at config write.
- Enabling Claude PAYG for real remains an **edit to an OmniRoute combo** —
  adding a second leg — per this epic's architecture. The unlock exists to move
  the flag out of company hands, not to add a Claude PAYG code path here.

## [0.2.2] - 2026-08-23

### Fixed

- **The Claude block no longer trusts a config-supplied `family` field
  (TOG-237).** `isClaudeFamily` decided membership entirely from
  `models[].family`, which the company supplies. A plain mislabel —
  `{ "id": "claude-opus-5", "family": "gpt", "providers": ["openrouter"] }` —
  made the function return false, so `permittedProvidersFor` never reached the
  claude-block branch and OpenRouter served the model with
  `outcome: "selected"`, an empty `rejections` array and not one trace line.
  The gate did not fail; it was never asked. Reproduced on v0.2.1 before the
  fix. This was the last route by which a Claude model could reach a
  non-teamclaude provider through the plugin, and the providers it would have
  reached are real: the OmniRoute catalogue read on 2026-08-22 carries 337 ids
  matching `/claude|anthropic/i` across `openrouter`, `opencode`, `theoldllm`,
  `combo` and `duckduckgo-web`.

  Closed in three layers, because only the first of them is the gate:

  1. **The engine** (`src/engine/select.ts`) now classifies a model as Claude if
     EITHER its id matches `/claude|anthropic/i` OR its declared family is in
     `providers.claudeFamilies`. The union is deliberate: configuration can
     still WIDEN the Claude block over a model whose id does not say "claude",
     but it can no longer narrow it off one that does. Owner rule 1 no longer
     depends on configuration being correct. This governs the block, the pooled
     quota gate, and therefore the fallback, the pin and stickiness, all of
     which are judged against the same `claude-block` rejection.
  2. **`onValidateConfig`** now returns `ok: false` for a model whose id names
     Claude but whose family is not in `providers.claudeFamilies` — it reported
     `ok: true` on exactly this config before. The inverse (a non-Claude id
     filed under a Claude family) is a warning, not an error: it only ever
     widens the block, so it cannot leak, but it silently confines a
     non-Anthropic model and reads as an outage.
  3. **`instanceConfigSchema`** refuses a Claude/Anthropic id whose `family`
     does not also name Claude or Anthropic. `POST /plugins/:id/config` validates
     here and never calls `onValidateConfig`, so this is the only layer that can
     refuse the *write*.

- A config that mislabels a model now says so **in the trace on every decision**,
  and the `claude-block` rejection reason names the mislabel, so the original
  complaint — that this failed silently — does not survive in a weaker form.

### Notes for operators

- **This schema rule is a strict SUBSET of the validator rule, on purpose, and
  the difference is documented rather than papered over.** The validator's rule
  reads `providers.claudeFamilies` from another branch of the same document.
  JSON Schema draft-07 cannot express a cross-branch instance reference; Ajv's
  `$data` extension can, but the host builds its validator as
  `new Ajv({ allErrors: true })` with `$data` off, where a `$data` reference is
  a schema-COMPILE error that would fail the install rather than a weaker check.
  Verified, not assumed — `tests/config.spec.ts` asserts the throw. So
  `{ "id": "claude-opus-5", "family": "anthropic" }` with
  `claudeFamilies: ["claude"]` passes the schema, is refused by
  `onValidateConfig`, and is confined by the engine regardless. The enforcement
  point is the engine.
- **Keying the block on the model id can in principle confine a non-Anthropic
  model that borrows the name.** Checked rather than assumed: of the 1,422 ids
  in the OmniRoute catalogue on 2026-08-22, 337 match the pattern and all 153
  distinct model names among them are Anthropic Claude models. There is no false
  positive to confine today. If the catalogue ever gains a third-party model with
  "claude" or "anthropic" in its name, it will be wrongly confined to
  `claudeFamilyProvider` — a refusal, which is the safe direction, and visible in
  the trace.
- **Existing configs may now be refused at write time.** A company whose model
  table files a Claude id under a non-Claude family was already misconfigured and
  was silently bypassing the Claude block; it must fix the `family` value or add
  that family to `providers.claudeFamilies` before its next config write. Both
  shipped fixtures are unaffected, and routing behaviour for a correctly labelled
  table is byte-for-byte unchanged.

## [0.2.1] - 2026-08-23

### Added

- **`npm run rehearse` — the two-company acceptance rehearsal**
  (`scripts/acceptance-rehearsal.mjs`). The acceptance criterion is that ONE
  install serves a SECOND company with no code edits, and proving it live needs
  instance authority this plugin does not have. This proves every part of it
  that does not: it loads the **built** `dist/worker.js` (the tests load
  `src/`), runs a **single** `createPlugin()` and a **single** `setup(ctx)` for
  both companies — the production topology, where one worker process keeps
  companies apart through `ctx.config.get(companyId)` alone — and emits the five
  numbered evidence items the operator captures live, so the live run is a diff
  against a known-good transcript rather than an open question. Takes real
  company ids and config paths via env; `--json` writes a machine-readable
  transcript. `tests/rehearsal.spec.ts` runs it as part of `npm test`, so the
  acceptance criterion cannot be broken without a red build and there is no
  separate CI wiring to keep in sync.
- The rehearsal also checks mechanically what was previously only asserted in
  prose: the shipped bundle contains no company UUID and branches on no company
  id literal.
- **Evidence 4 now exercises the hostile fallback.** The first version of the
  check asserted that no Claude model is served once PAYG is off, and passed —
  but only because company B's fallback is `gpt-4.1-mini`, so the fallback path
  was never the thing under test. The case TOG-228 found live is a fallback that
  *names* a Claude model: it is in the company's table, so config validation
  accepts it, and before the fix it was returned without consulting the
  `claude-block` rejection that had just eliminated it. Evidence 4 now points
  B's `fallbackModelId` straight at the blocked `claude-sonnet-5` and asserts
  the block outranks it — `no-eligible-model`, with the refusal named in the
  trace. On `0.1.1` the same check serves `claude-opus-5` as `selected`.

### Fixed

- The README's Status section still said `0.1.0` after the `0.1.1` release.

### Notes

- No behaviour change here; the engine is untouched by this entry.
- Building the rehearsal corrected the operator runbook, which said a refused
  Claude route yields `no-eligible-model`. In a company that configures
  `routing.fallbackModelId` the outcome is `selected` on the fallback, so the
  evidence to check is "a `claude-block` rejection is present and no Claude
  model was served", not the outcome value.
- Pulling that thread surfaced a real hole, tracked separately in **TOG-228** and
  **fixed in `0.2.0` below**, which this entry now sits on top of:
  `routing.fallbackModelId` was returned without consulting the rejection that
  eliminated it, so a fallback naming a Claude model was served even with
  `claudePaygEnabled: false` and every Claude model reachable only via
  `openrouter` — straight through owner rule 1. The pin and stickiness paths
  already judged their candidate against the hard gates; the fallback path was
  the one that did not. Fixed under TOG-228, not here. The rehearsal has been
  re-run against that fix and evidence item 4 is sound as of `0.2.0`.

## [0.2.0] - 2026-08-23

Findings from the independent QA review in TOG-228. Every item below was
reproduced against `v0.1.1` before it was fixed, and each has a regression test
in `tests/gate-integrity.spec.ts` written as the attack that worked.

### Security

- **`routing.fallbackModelId` crossed the Claude block.** Rule 1 says a
  Claude-family model resolves to `teamclaude` or not at all while PAYG is off.
  The fallback was applied without consulting a single rejection, so a company
  whose Claude models were all `claude-block`-rejected still received
  `claude-opus-5` with `outcome: "selected"`. The same path bypassed the Claude
  **quota pause**: `gates.claudeQuota: "halt"` and a Claude model selected
  anyway. The fallback may now cross the *estimates* — tier ceiling, quality
  floor, capability, context window — and may not cross a hard constraint:
  `not-in-table`, `claude-block`, `provider-not-permitted` or `quota-gate`. See
  ADR 0006.
- **A credential could be stored in a company's config.** `format: "secret-ref"`
  is registered host-side as
  `ajv.addFormat("secret-ref", { validate: () => true })` — a picker hint with
  no validation behind it — and `format` is a string-only keyword regardless, so
  it was inert on this object-typed field. The host's secret-ref extractor
  ignores any value that is not literally `{ type: "secret_ref" }`, so
  `{"apiKey": "sk-ant-..."}` validated, was not recognised as a binding, and was
  persisted verbatim. `quotaGate.apiKeySecretRef` now pins the exact shape in
  `instanceConfigSchema` with `additionalProperties: false` — which is what the
  persisting write actually enforces — and `onValidateConfig` repeats the check.
- **The gitleaks path allowlist was too broad.** `README.md`, `docs/*.md` and
  `CHANGELOG.md` were allowlisted by path, which disables *every* rule for those
  files: the two custom rules and the whole gitleaks default ruleset with them.
  Those are exactly the files a credential gets pasted into by accident. The
  path allowlist is gone; the narrower regex allowlist still covers the strings
  the docs legitimately contain.

### Fixed

- **The budget halt did not halt.** Both the stickiness branch and the fallback
  branch returned a model before the halt check was reached, so a company at 99%
  of its cap kept spending and the trace did not even mention the refusal. The
  halt now sits directly below the pin, above every other route out of the
  engine. A pin remains the one documented exception.
- **A mistyped `taskClass` silently deleted the quality floor.** An unconfigured
  class key fell through to floor `0`, so `architecture` selected
  `claude-sonnet-5` at floor 85 while `architecure` selected `qwen3-coder` at
  quality 45 — cost beating the quality floor, reached by a typo. Naming a class
  this company has not configured is now refused. Sending no `taskClass` at all
  is unchanged.
- **The scoped HTTP route had its own routing engine.** `POST /issues/:id/route`
  called `selectModel` directly rather than the shared decision path, so it
  applied no quota gate, no stickiness, wrote no decision-log entry and emitted
  no metric — the surface most likely to be hit by hand was the one nothing
  recorded. All four surfaces now go through one function.
- **An unreadable quota gate looked like a healthy one.** The reader fails soft
  on purpose, but the resulting `gates.claudeQuota: "ok"` means *unknown*, not
  *healthy*. When the gate is enabled and utilization could not be read, the
  trace now says so and carries the reason.

### Changed

- `RoutingDecision` gains `fallbackUsed: boolean`. A fallback clears every hard
  constraint but has *not* cleared the capability, context or quality checks, so
  a caller treating `outcome: "selected"` as "this model can do the job" needs
  to read this too.
- `routing.fallbackModelId` naming a model outside the company's table is now an
  `onValidateConfig` **error** rather than a warning. An id no gate has seen is
  exactly how a Claude model reaches a PAYG provider.
- Dropped three capabilities the worker never exercised: `companies.read`,
  `issues.read` and `activity.log.write`. `tests/manifest.spec.ts` no longer
  only pins the list — it checks each declared capability against a call site in
  `src/worker.ts`, because a pin records the last decision and cannot notice a
  capability that stopped being used.

### Compatibility

Config written for `0.1.x` continues to validate, with two deliberate
exceptions: a `quotaGate.apiKeySecretRef` that was not a real secret reference
is now rejected at write time, and a `routing.fallbackModelId` outside the model
table is now an error. Callers that pass a `taskClass` absent from the company's
`taskClasses` will start receiving `no-eligible-model` where they previously
received the cheapest model in the table.

## [0.1.1] - 2026-08-23

### Fixed

- **The published tarball was not installable as documented.** `dist/` ships
  without `node_modules`, and the plugin SDK is deliberately external to the
  bundle, so loading `dist/worker.js` from an unpacked release failed with
  `ERR_MODULE_NOT_FOUND: @paperclipai/plugin-sdk` — at worker start, not at
  install. Found by downloading the real `v0.1.0` release and loading it.
  Install instructions in the README, `docs/OPERATIONS.md` and the operator
  runbook now include the required `npm install --omit=dev --ignore-scripts`
  step, and CI packs, unpacks, installs runtime dependencies and loads both
  entrypoints on every push so it cannot regress.
- `npm pack --pack-destination` does not create its target directory, so the
  `v0.1.0` release build failed at ENOENT after a green verify.

## [0.1.0] - 2026-08-23

First release. Installs globally, configures per company.

### Added

- **Routing engine** (`src/engine/select.ts`) applying, in order: Rule 0, hard
  capability gates, the Claude block, the quality floor, then cheapest survivor.
  Every decision carries a full reasoning trace and the rejection reason for
  every model that did not make it.
- **Per-company configuration contract** (`src/config/schema.ts`) covering the
  model tier table, task-class quality floors, tiering weights and thresholds,
  budget thresholds, permitted providers, the Claude pay-as-you-go toggle, the
  quota-gate thresholds, and Rule 0 patterns. This is the entire per-company
  surface; nothing company-specific exists in code.
- **Cross-field config validation** through `onValidateConfig`, so a duplicate
  model id, an unresolvable pin, out-of-order thresholds, an invalid Rule 0
  pattern or a quota gate with no URL is rejected when it is written rather than
  when it is used.
- **teamclaude quota reader** (`src/quota/teamclaude.ts`) treating utilization as
  a fraction in [0,1], taking the worst window across accounts, and degrading to
  an unknown-but-open gate when the endpoint is unreachable.
- **Cache-preserving stickiness**: the model already used on an issue is kept
  while it clears the hard gates, because switching mid-task destroys the prompt
  cache. Budget and quota pressure still override it.
- **Agent tool** `model_router_select`, bridge actions `route` and
  `refresh-quota`, data keys `effective-config`, `decisions` and `quota`, and two
  scoped API routes.
- Documentation: install and configuration reference, the OmniRoute-global vs
  plugin-per-company boundary, operations runbook, and five decision records.
- CI running typecheck, tests, build, built-manifest load, version/changelog
  sync and a gitleaks secret scan; a release workflow that publishes a
  version-pinned tarball.

### Known limitations

- `routing.mode: "enforce"` behaves as `advise`. The plugin SDK exposes
  `assigneeAdapterOverrides` on issue **create** but not on issue **update**, so
  a decision cannot yet be applied to an existing issue from a plugin worker.
  See `docs/decisions/0005-advise-before-enforce.md`.
- Budget pressure is supplied by the caller as `budgetSpentFraction`. The plugin
  does not read company spend itself; it holds no `costs.read` capability.

[Unreleased]: https://github.com/TogetherWeOwn/paperclip-model-router/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/TogetherWeOwn/paperclip-model-router/compare/v0.2.7...v0.4.0
[0.2.7]: https://github.com/TogetherWeOwn/paperclip-model-router/compare/v0.2.6...v0.2.7
[0.1.1]: https://github.com/TogetherWeOwn/paperclip-model-router/releases/tag/v0.1.1
[0.1.0]: https://github.com/TogetherWeOwn/paperclip-model-router/releases/tag/v0.1.0
