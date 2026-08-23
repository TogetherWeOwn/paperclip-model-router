# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

A company can be pinned to any released version, so the compatibility notes on
each entry matter as much as the feature list. CI refuses to tag a release whose
version is not present here.

## [Unreleased]

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
