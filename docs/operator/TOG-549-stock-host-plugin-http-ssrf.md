# TOG-549 — stock host plugin HTTP SSRF correction

**Result:** the current stock host predicate is bypassable by reserved resolved addresses. The attached patch (sha256 `d86c63b881d25825c0638925f954df63d75c0946f739451e40c1771adabe3831`) makes plugin HTTP use the host's canonical remote-endpoint IP predicate and fail closed when any DNS answer is forbidden.

This repository does not own the Paperclip host source under `/app`, so this is the smallest exact upstream patch and executable verification artifact. It has not been published to a third-party repository. The current `/app` source tree contains the patched files and passes the checks below; this verification does not prove that the long-running host process has restarted onto those sources.

## Re-derived finding

The stock plugin path resolves once, connects directly to the chosen address, preserves the original HTTP `Host`/TLS server name, and does not implement redirect following. Those properties are retained.

The omitted classes were derived from current source, not from the issue summary. The stock plugin predicate rejected RFC 1918, IPv4 loopback, IPv4 link-local, exactly `0.0.0.0`, IPv6 loopback/unspecified, ULA, exactly the textual prefix `fe80`, and dotted IPv4-mapped IPv6. Against the canonical host predicate at `/app/server/src/services/remote-http-endpoint-guard.ts:96-160`, it missed:

- IPv4 `0.0.0.0/8` except the single all-zero address;
- CGNAT `100.64.0.0/10`;
- protocol assignments `192.0.0.0/24`;
- TEST-NET-1 `192.0.2.0/24`;
- 6to4 relay anycast `192.88.99.0/24`;
- benchmarking `198.18.0.0/15`;
- TEST-NET-2 `198.51.100.0/24` and TEST-NET-3 `203.0.113.0/24`;
- IPv4 multicast/reserved `224.0.0.0/4` and `240.0.0.0/4`;
- hexadecimal IPv4-mapped IPv6 such as `::ffff:7f00:1`, and mapped instances of every omitted IPv4 class;
- the rest of IPv6 link-local `fe80::/10` because the stock textual check only matched `fe80...`;
- the canonical predicate's textual `100::/16` block (broader than the nominal discard-only `100::/64` allocation);
- protocol-assignment `2001:0000::/32`, benchmarking `2001:2::/48`, and the canonical predicate's ORCHID block spanning second hextets `0x20`–`0x2f`;
- documentation `2001:db8::/32`, 6to4 `2002::/16`, the canonical predicate's textual `64:ff9b::/32` NAT64 block, and IPv6 multicast `ff00::/8`.

The old plugin flow also filtered forbidden answers and continued if any public answer remained. The canonical guard fails closed when any answer is forbidden at `/app/server/src/services/remote-http-endpoint-guard.ts:70-72`.

## Artifact

Apply [`TOG-549-stock-host-plugin-http-ssrf.patch`](./TOG-549-stock-host-plugin-http-ssrf.patch) at the Paperclip host repository root:

The artifact is intentionally a zero-context patch so it contains no trailing context whitespace and passes this repository's `git diff --check`. Apply it with:

```bash
git apply --unidiff-zero --check TOG-549-stock-host-plugin-http-ssrf.patch
git apply --unidiff-zero TOG-549-stock-host-plugin-http-ssrf.patch
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

Result: exit `1`; **22 failed, 1 passed**. The unmodified predicate accepted every enumerated omitted class and the mixed public/CGNAT answer. The public pinned-transport/no-redirect case passed. The failures are true executable mutations: the forbidden-address cases resolved with a synthetic HTTP `200` instead of rejecting, while the mixed-answer case attempted the pinned request.

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
Tests      29 passed (29)
```

The TypeScript command exited `0` with no output.

The positive transport case asserts exactly one DNS lookup and one HTTP request, connection `host: "93.184.216.34"`, original `Host: api.example.test:8080`, and a returned `302` response while the HTTPS request mock remains unused. Thus the correction preserves resolve-once pinning and does not follow redirects.

## Operator/vendor handoff

A Paperclip host source owner should apply the patch in the company-owned host repository, rerun the commands above, and route it through that repository's normal review and release path. Do not open a public upstream issue or pull request without the required public-commitment authority.

## Rollback

Before commit, reverse the patch:

```bash
git apply --unidiff-zero -R TOG-549-stock-host-plugin-http-ssrf.patch
```

After commit, use the host repository's normal `git revert <commit>` path. The rollback restores the prior incomplete range predicate and mixed-answer filtering, so it also restores the SSRF gap; use it only to recover from an independently demonstrated regression.
