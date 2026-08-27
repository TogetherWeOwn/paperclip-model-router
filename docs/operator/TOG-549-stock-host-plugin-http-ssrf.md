# TOG-549 — stock host plugin HTTP SSRF correction

**Result:** the current stock host predicate is bypassable by reserved resolved addresses. The attached patch makes plugin HTTP use the host's canonical remote-endpoint IP predicate and fail closed when any DNS answer is forbidden.

This repository does not own the Paperclip host source under `/app`, so this is the smallest exact upstream patch and executable verification artifact. It has not been published to a third-party repository or installed into a running host.

## Re-derived finding

The stock plugin path resolves once, connects directly to the chosen address, preserves the original HTTP `Host`/TLS server name, and does not implement redirect following. Those properties are retained.

The omitted classes were derived from current source, not from the issue summary:

- `/app/server/src/services/plugin-host-services.ts:109-133` only rejected RFC 1918, loopback, link-local, unspecified, IPv6 ULA, and dotted IPv4-mapped IPv6.
- `/app/server/src/services/remote-http-endpoint-guard.ts:96-160` is the host's comprehensive predicate. In addition it rejects CGNAT `100.64/10`; `0/8`; IPv4 protocol-assignment, documentation, 6to4-relay, benchmarking, multicast and reserved ranges; hexadecimal IPv4-mapped IPv6; and IPv6 discard-only, reserved `2001` space, documentation, benchmarking, ORCHID, 6to4, NAT64, and multicast space.
- `/app/server/src/services/plugin-host-services.ts:196-206` filtered unsafe answers and continued when another public answer existed. The canonical guard rejects a hostname if any answer is forbidden at `/app/server/src/services/remote-http-endpoint-guard.ts:70-72`.

## Artifact

Apply [`TOG-549-stock-host-plugin-http-ssrf.patch`](./TOG-549-stock-host-plugin-http-ssrf.patch) at the Paperclip host repository root:

```bash
git apply --check TOG-549-stock-host-plugin-http-ssrf.patch
git apply TOG-549-stock-host-plugin-http-ssrf.patch
```

The patch:

1. exports the canonical `isPrivateOrReservedIp` predicate;
2. removes the duplicate incomplete plugin predicate;
3. rejects the entire DNS result set if any address is forbidden;
4. adds stock HostServices tests for CGNAT, reserved IPv4/IPv6, both IPv4-mapped IPv6 forms, a mixed public/forbidden result, public IP pinning, original `Host` preservation, and redirect refusal.

## Executable mutation evidence

With the test file present but the two source files restored to the unmodified stock versions:

```bash
cd /app/server
../node_modules/.bin/vitest --config vitest.config.ts run \
  src/__tests__/plugin-host-services-http-fetch.test.ts
```

Result: exit `1`; **15 failed, 1 passed**. The unmodified predicate accepted CGNAT, reserved/documentation/benchmark IPv4, hexadecimal IPv4-mapped IPv6, reserved IPv6, and a mixed public/forbidden DNS answer. The public pinned-transport/no-redirect case passed.

After applying the patch:

```bash
cd /app/server
../node_modules/.bin/vitest --config vitest.config.ts run \
  src/__tests__/plugin-host-services-http-fetch.test.ts \
  src/__tests__/remote-http-endpoint-guard.test.ts
../node_modules/.bin/tsc --noEmit --pretty false
```

Result:

```text
Test Files  2 passed (2)
Tests      22 passed (22)
```

The TypeScript command exited `0` with no output.

The positive transport case asserts exactly one DNS lookup and one HTTP request, connection `host: "93.184.216.34"`, original `Host: api.example.test:8080`, and a returned `302` response while the HTTPS request mock remains unused. Thus the correction preserves resolve-once pinning and does not follow redirects.

## Operator/vendor handoff

A Paperclip host source owner should apply the patch in the company-owned host repository, rerun the commands above, and route it through that repository's normal review and release path. Do not open a public upstream issue or pull request without the required public-commitment authority.

## Rollback

Before commit, reverse the patch:

```bash
git apply -R TOG-549-stock-host-plugin-http-ssrf.patch
```

After commit, use the host repository's normal `git revert <commit>` path. The rollback restores the prior incomplete range predicate and mixed-answer filtering, so it also restores the SSRF gap; use it only to recover from an independently demonstrated regression.
