# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

A company can be pinned to any released version, so the compatibility notes on
each entry matter as much as the feature list. CI refuses to tag a release whose
version is not present here.

## [Unreleased]

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
