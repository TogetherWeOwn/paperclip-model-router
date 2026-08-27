# TOG-550 — scoped private-origin access for plugin HTTP

**Finding:** the installed OmniRoute broker is healthy through authentication, issue gating, configuration, and secret resolution. Its first management request fails in the Paperclip host's `http.fetch` JSON-RPC handler because `omniroute` resolves only to a private container address.

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

## Minimal correction

Apply [`TOG-550-paperclip-plugin-private-origin.patch`](./TOG-550-paperclip-plugin-private-origin.patch) in the Paperclip host source tree.

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

## Host/operator-only deployment action

This agent can modify files inside the running container but cannot safely rebuild and restart the Paperclip container from inside itself. The host operator/source owner should:

1. Apply the patch to the company-owned Paperclip host source.
2. Run the two commands above.
3. Set exactly:
   ```text
   PAPERCLIP_PLUGIN_HTTP_PRIVATE_ORIGINS={"omniroute-broker":["http://omniroute:20128"]}
   ```
4. Build and restart Paperclip through the normal host deployment path.
5. From an agent assigned to an active issue, verify `POST /api/plugins/omniroute-broker/api/issues/<issueId>/read` with body `{"verb":"providers.list"}` returns HTTP 200 and scrubbed records. Do not print full provider records; verify only status, count, and the closed output-key set.

No OmniRoute provider, combo, mapping, credential, or configuration mutation is part of this correction.

## Rollback

Remove `PAPERCLIP_PLUGIN_HTTP_PRIVATE_ORIGINS`, reverse the patch, rebuild, and restart Paperclip. This restores the current default-deny behavior for every private destination, including OmniRoute.
