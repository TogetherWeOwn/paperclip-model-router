import { vi } from "vitest";

// TOG-7884 (gap G6): the upstream/capacity paths resolve the request hostname
// at request time (checkResolvedHost) and refuse private/reserved answers.
// The default resolver is the worker's real DNS, which makes any test that
// reaches it depend on the runner's network: latency, search domains, and
// ENOTFOUND-vs-timeout behavior all vary box to box, and a slow resolver can
// blow vitest's per-test timeout on suites that invoke many times. Pin DNS
// to a public address so the suite exercises the transport, not the network.
//
// This only affects the DEFAULT resolver. Tests that pass an explicit
// `resolveHostAddresses` (notably tog-7884-ssrf-rebinding.spec.ts) keep full
// control of the verdict — the mock never overrides an explicit argument.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
