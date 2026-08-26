# Operations

The compatible-upstream implementation is not authorized for a public release or live installation by TOG-532. This runbook documents the private artifact and verification path only.

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

## Expected safety properties

- Company identity is resolved by the host for tools, actions, and routes.
- Rule 0 and selection refusals make no secret-resolution or HTTP call.
- The credential is resolved at call time and used only in the protocol auth header.
- Inference performs exactly one `ctx.http.fetch` with `redirect: "manual"` and `Accept-Encoding: identity`.
- A transport failure never causes automatic replay or post-HTTP model fallback.
- Decision records are company-scoped and exclude prompts, messages, tool inputs/results, credentials, full URLs, error bodies, and deployment identity.
- Native metrics are aggregate and contain no company tag.

## Reversibility

Before any authorized installation, preserve the previously installed artifact and every company's previous config payload. The implementation undo path is a git revert plus restoring the prior artifact/config. Do not infer that an older release is safe to install merely because it exists; authorization and compatibility are separate gates.
