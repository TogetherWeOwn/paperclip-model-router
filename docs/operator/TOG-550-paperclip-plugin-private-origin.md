# TOG-550 — OmniRoute broker `JsonRpcCallError` diagnosis

> **Selected correction (2026-08-27):** use the existing public TLS management origin `https://router.infextion.net` in the installed broker configuration. **Do not deploy the proposed Paperclip host patch in this directory.** The owner applied the configuration change after confirming that the public origin reaches the correct OmniRoute management plane with the expected unauthenticated HTTP 401.

**Finding:** the installed OmniRoute broker was healthy through authentication, issue gating, configuration, and secret resolution. Its first management request failed in the Paperclip host's `http.fetch` JSON-RPC handler because the original `omniroute` hostname resolved only to a private container address.

## Evidence

- Agent-authenticated broker `whoami` returned HTTP 200.
- Agent-authenticated `providers.list` on assigned TOG-550 returned HTTP 502.
- Direct unauthenticated `http://omniroute:20128/api/providers` returned the expected HTTP 401 in 20 ms, proving DNS, transport, and service reachability without exposing the management key.
- Host log `/paperclip/instances/default/logs/server.log:626245-626250` records the exact failing layer:
  - `method: "http.fetch"`
  - `All resolved IPs for omniroute are in private/reserved ranges`
  - broker route `read` then emits the safe `Management request failed to complete (JsonRpcCallError).`
- The active host gate is `/app/server/src/services/plugin-host-services.ts:127-190`; `buildHostServices().http.fetch` invokes it at `/app/server/src/services/plugin-host-services.ts:1531-1545`.

This is not an OmniRoute credential or reachability failure. The host rejects the target before opening the authenticated HTTP request.

## Selected runtime correction

The installed broker configuration now uses:

```text
managementBaseUrl=https://router.infextion.net
```

This preserves the stock Paperclip host SSRF boundary and uses the existing public TLS route to the same management plane. After the configuration change, this run verified `whoami` returned HTTP 200 and matched the current company, agent, and run. The single instructed `providers.list` attempt could not exercise the management request because TOG-550 had already been reassigned; the broker correctly returned HTTP 403 `Issue is not assigned to the calling agent.` The current assignee owns the one remaining acceptance read.

## Rejected alternative retained for diagnostic reference only

[`TOG-550-paperclip-plugin-private-origin.patch`](./TOG-550-paperclip-plugin-private-origin.patch) was built and tested before the existing public TLS route was selected. It must not be deployed unless a future authorized decision explicitly reverses the selected correction.

The patch adds a fail-closed instance environment variable:

```text
PAPERCLIP_PLUGIN_HTTP_PRIVATE_ORIGINS={"omniroute-broker":["http://omniroute:20128"]}
```

The exception is keyed by plugin manifest key and exact URL origin. It does **not** allow another plugin, another port, another protocol, URL credentials, paths, query strings, fragments, or arbitrary private-network destinations. DNS is still resolved once and the selected address remains pinned for the request. Malformed configuration fails closed for private targets.

Patch sha256:

```text
f921dd7f8beb29960df2896b4e18e17b959c2c92b23bfe0af9b4199d1a6b0f43
```

## Verification already run

Against a complete copy of the active `/app/server/src` tree with the existing dependency tree attached:

```bash
/app/node_modules/.bin/vitest --config /app/server/vitest.config.ts run \
  src/__tests__/plugin-host-services-http-fetch.test.ts
/app/node_modules/.bin/tsc --noEmit --pretty false --project tsconfig.json
```

Result:

```text
Test Files  1 passed (1)
Tests      26 passed (26)
```

TypeScript exited 0 with no output. The tests retain all 23 stock SSRF/transport cases and add executable checks for exact plugin+origin access, wrong-port refusal, other-plugin refusal, and malformed-config refusal.

## Remaining acceptance verification

From the agent currently assigned to TOG-550, call `POST /api/plugins/omniroute-broker/api/issues/<issueId>/read` exactly once with body `{"verb":"providers.list"}`. Report only HTTP status, provider count, scrubbed top-level keys, and the record-key set; do not print provider records.

No OmniRoute provider, combo, mapping, or credential mutation is part of this correction. The only applied change was the installed broker's `managementBaseUrl`.

## Rollback

Restore the prior broker `managementBaseUrl` value if the public TLS route causes an independently demonstrated regression. Doing so also restores the original private-address rejection, so the broker's management reads will return HTTP 502 until another authorized path is selected.
