# Operations

This runbook covers the private `0.3.1` compatible-upstream artifact. It is
not authorized for a public release or live installation, and it does not
authorize npm publication. The package must remain `private: true` and
`UNLICENSED` until a separate owner decision covers licensing, publication, and
brand positioning.

`v0.2.7` is obsolete for acceptance and installation. It implements the removed
selection-only/provider-policy product; do not reuse its release asset, install
commands, acceptance transcript, or rollback path for this implementation.

## Blast radius

- Plugin install or upgrade is instance-wide and restarts workers.
- Company config, secret reference, and state are company-scoped.
- A configured compatible upstream may itself have wider routing behavior; that is outside this plugin.

## Build and validate

```sh
npm ci
npm run typecheck
npm test
npm run build
PAPERCLIP_HOST=/app npm run verify:host
npm run rehearse
```

`verify:host` validates the built manifest and both shipped config fixtures through Paperclip's install-time validators. `rehearse` loads one built worker, configures two companies with different compatible protocols and secret references, invokes both, and checks state isolation.

## Create and inspect the private artifact

Create the versioned tarball locally; do not tag, publish, or create a GitHub
release as part of this path:

```sh
ARTIFACT_DIR="$PWD/artifacts/private"
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
npm pack --pack-destination "$ARTIFACT_DIR"
ARTIFACT="$ARTIFACT_DIR/togetherweown-paperclip-model-router-0.3.1.tgz"
test -f "$ARTIFACT"
tar -tzf "$ARTIFACT"
sha256sum "$ARTIFACT"
```

The listing must contain `package/package.json`, `package/README.md`,
`package/CHANGELOG.md`, and both built entrypoints under `package/dist/`. It must
not contain `src/`, tests, credentials, a Paperclip checkout, or private host
source. The runtime dependency is the public package
`@paperclipai/plugin-sdk@2026.817.0`; the packed artifact does not import `/app`
or any copied host module.

Prove the file an operator would consume can install and load in a clean
directory:

```sh
INSTALL_DIR="${PAPERCLIP_RUN_SCRATCH_DIR:-$PWD/.release-check}/installed-0.3.1"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$ARTIFACT" -C "$INSTALL_DIR" --strip-components=1
(
  cd "$INSTALL_DIR"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
  node --input-type=module -e '
    const manifest = (await import("./dist/manifest.js")).default;
    const worker = await import("./dist/worker.js");
    if (manifest.version !== "0.3.1") throw new Error(`unexpected version ${manifest.version}`);
    if (typeof worker.default?.definition?.setup !== "function") throw new Error("packed worker has no setup handler");
    console.log(`packed artifact loads: ${manifest.id} v${manifest.version}`);
  '
)
```

This is private artifact preparation, not an instance install. A later authorized
install must consume this checked tarball (identified by its SHA-256), not a
checkout and not an independently rebuilt file.

## Configure a company

Use a company-scoped plugin config containing:

- `routing`: enablement, pre-HTTP fallback, issue stickiness, and maximum output tokens;
- `upstream`: compatible protocol, HTTPS base URL, Paperclip secret reference, request timeout, response-size ceiling, and safe extra headers;
- `models`: opaque IDs with tier, quality, price, context, and capability facts;
- `taskClasses`, `tiering`, `budget`, and Rule 0 patterns.

Start from `tests/fixtures/company-a.json` or `tests/fixtures/company-b.json`.

The secret field accepts only the closed Paperclip reference object. Store the actual credential in Paperclip's secret provider and bind its UUID; never paste the credential into config.

## Verify a configured company

Invoke through a company-scoped route:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/api/invoke?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task":{"taskClass":"implementation"},
    "messages":[{"role":"user","content":"Return OK."}],
    "maxOutputTokens":64
  }'
```

A completed handler operation returns HTTP 200 even when the compatible upstream failed; inspect `outcome` and `error`. Invalid native request bodies return HTTP 400. Host authorization, body-size, bridge, and worker failures may return other host statuses before the plugin handler completes.

## Required live OmniRoute acceptance gate

The local rehearsal proves protocol adaptation and one-install/two-company
isolation without spending live inference. It does not prove that the configured
production multiplexer accepts both protocol profiles. Before any authorized
installation is accepted, an operator must run the same installed plugin once
for each of two companies whose configurations differ in all three upstream
bindings:

| company | `upstream.protocol` | required live target |
| --- | --- | --- |
| A | `openai-chat-completions` | OmniRoute's OpenAI-compatible endpoint |
| B | `anthropic-messages` | OmniRoute's Anthropic-compatible endpoint |

For each company, use a Paperclip secret reference owned by that company, invoke
through a host-authorized native route, and retain a redacted result showing:

1. `outcome: "completed"`;
2. the configured protocol in `response.upstream.protocol`;
3. a non-empty normalized text or tool-call result;
4. the selected opaque `modelId` and bounded token usage when supplied;
5. a company-scoped decision record for that operation; and
6. no state, config, secret reference, request content, or result crossing to the
   other company.

This gate is mandatory and cannot be replaced by unit tests, the local rehearsal,
or a direct call to OmniRoute. A failure stays a failed acceptance result; do not
change model, replay automatically, or bypass the plugin to make the gate green.

## Expected safety properties

- Company identity is resolved by the host for tools, actions, and routes.
- Rule 0 and selection refusals make no secret-resolution or HTTP call.
- The credential is resolved at call time and used only in the protocol auth header.
- Inference performs exactly one `ctx.http.fetch` with `redirect: "manual"` and `Accept-Encoding: identity`.
- A transport failure never causes automatic replay or post-HTTP model fallback.
- Decision records are company-scoped and exclude prompts, messages, tool inputs/results, credentials, full URLs, error bodies, and deployment identity.
- Native metrics are aggregate and contain no company tag.

## Reversibility

Before any authorized installation, preserve the exact previously installed
tarball, its SHA-256, and every company's previous config payload. If `0.3.1`
regresses after an authorized install:

1. disable the plugin or remove the affected companies' enablement while keeping
   the preserved evidence;
2. restore the immediately preceding *compatible-upstream* artifact and its
   matching config, if one has been separately accepted; otherwise leave the
   plugin disabled;
3. verify the restored artifact with its own package/install/load and live
   acceptance evidence; and
4. revert the `0.3.1` implementation commit in source before preparing a new
   replacement artifact.

Do **not** roll back to `v0.2.7`. It is not the preceding implementation of this
contract; it is the obsolete product the contract removed. A tag or historical
release existing does not make it an authorized or compatible rollback target.
The private preparation itself is undone by deleting the local `artifacts/private`
directory and reverting the version/docs commit; it changes no instance.

## Public-option hygiene

The package has a public-package-compatible shape—declared runtime dependencies,
standard `files`, no `/app` import, and a clean tarball install—but public release
is intentionally withheld. Before any future publication decision, the owner
must separately decide license, repository visibility, package registry, name and
brand positioning, release-notes audience, support commitment, and credential/
security disclosure posture. Until then, retain `private: true`, `UNLICENSED`,
and the no-publish/no-public-release boundary.
