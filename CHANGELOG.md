# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

A company can be pinned to any released version, so the compatibility notes on
each entry matter as much as the feature list. CI refuses to tag a release whose
version is not present here.

## [Unreleased]

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

[Unreleased]: https://github.com/TogetherWeOwn/paperclip-model-router/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/TogetherWeOwn/paperclip-model-router/releases/tag/v0.1.1
[0.1.0]: https://github.com/TogetherWeOwn/paperclip-model-router/releases/tag/v0.1.0
