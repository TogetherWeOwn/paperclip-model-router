# Low-trust GitHub reviews: allow the review agent's model credential

**Result:** a host patch that lets a low-trust GitHub review use the assigned
review agent's own model-provider credential binding(s) and nothing else. Bot-
and guest-authored pull requests get an automatic review check on their head
again; every other secret stays refused.

This repository does not own the Paperclip host source, so this is the
smallest exact upstream patch plus executable verification. It has not been
published to a third-party repository. Base: host fork commit
`14f66a7cf6422b43fe87d1d747ceabdf9f23b583`. Patch sha256
`5c6ee2305e38de15d3cde07527d135d57b6da6bfeac4f1ef1e8a456d1788ee1f`.
Tracked for the next host build after the current cutover packet; it does not
disturb that packet.

## Problem

Every GitHub review for a bot-authored pull request failed at setup with
`setup_failed: Secret binding is outside the active low-trust boundary`,
while reviews for human-authored pull requests succeeded.

The host builds a `low_trust_review` trust boundary for any review task with
no Paperclip user principal (bot authors, external guests). That boundary
carried no `allowedSecretBindingIds`, so the run's adapter-config resolution
refused every agent secret binding — including the assigned review agent's
own model credential (for example `env.ANTHROPIC_AUTH_TOKEN`). The reviewer
could never start. Guest people are always low-trust, so allow-listing bot
authors in the review configuration could not work on its own.

## Fix

In `server/src/services/chat-channels.ts`:

- Add the secret-bearing model-provider credential env key set
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`,
  `GROK_API_KEY`). Paths and base URLs stay out: they are configuration,
  not credentials.
- Add `filterLowTrustModelBindingIds` (pure, tested): keeps bindings with
  `targetType: "agent"`, `targetId` equal to the assigned review agent, and
  a `configPath` in that key set. Everything else (GitHub tokens,
  unrelated env, other agents' bindings) is excluded.
- Add `resolveLowTrustModelBindingIds`: loads exactly those bindings for
  the endpoint's assigned agent inside the same transaction that builds the
  boundary, so membership is validated by construction.
- When building the low-trust boundary, union the resolved model binding
  ids with any operator-set allowlist entries already on the issue boundary
  and store the result as `allowedSecretBindingIds`. The heartbeat already
  enforces that allowlist for agent, environment, project and routine env;
  this patch is its first production producer.

New tests in `server/src/__tests__/low-trust-model-bindings.test.ts` cover:
the path set contains the model credential keys and excludes base URLs, home
dirs and GitHub tokens; the filter keeps only the assigned agent's model
bindings; the model binding is allowed while any other binding stays refused;
ids dedupe and sort; no agent yields no bindings.

## Artifact

Apply [`low-trust-review-model-credential.patch`](./low-trust-review-model-credential.patch)
at the Paperclip host repository root:

```bash
git apply --check low-trust-review-model-credential.patch
git apply low-trust-review-model-credential.patch
```

## Verification (host source tree)

```bash
cd server
../node_modules/.bin/vitest run src/__tests__/low-trust-model-bindings.test.ts
../node_modules/.bin/vitest run src/__tests__/heartbeat-project-env.test.ts src/__tests__/trust-preset-resolver.test.ts src/__tests__/run-trust-preset.test.ts
../node_modules/.bin/tsc --noEmit --pretty false
```

Results on the patched tree:

- `low-trust-model-bindings.test.ts`: 5 passed (new).
- Consumer suites (`heartbeat-project-env`, `trust-preset-resolver`,
  `run-trust-preset`): 51 passed.
- `tsc --noEmit`: clean.

The host tree was restored after verification; the patch file above is the
tracked input.

## Upstream route

Upstream publication goes through the normal audits, steward and operator
review path with public-safe text (no internal ticket ids, links or hosts).
This patch file is the tracked fork input for that route.

## Rollback

Before commit, reverse the patch:

```bash
git apply -R low-trust-review-model-credential.patch
```

After commit, use the host repository's normal `git revert <commit>` path.
Rollback restores the previous behavior: low-trust reviews refuse all secret
bindings, so bot- and guest-authored pull request reviews fail at setup
again.
