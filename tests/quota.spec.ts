import { describe, expect, it } from "vitest";

import { DEFAULT_QUOTA_GATE } from "../src/config/resolve.js";
import type { QuotaGateConfig } from "../src/config/types.js";
import { readQuotaSnapshot, type QuotaHttpClient } from "../src/quota/teamclaude.js";

const NOW = "2026-08-23T00:00:00.000Z";

function client(response: { status: number; body: unknown }): QuotaHttpClient & {
  calls: Array<{ url: string; headers?: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  return {
    calls,
    async request({ url, headers }) {
      calls.push({ url, headers });
      return response;
    },
  };
}

function gate(overrides: Partial<QuotaGateConfig> = {}): QuotaGateConfig {
  return {
    ...DEFAULT_QUOTA_GATE,
    enabled: true,
    statusUrl: "http://host.containers.internal:3456/teamclaude/status",
    ...overrides,
  };
}

/** Shape of the real endpoint: per-account records nested under the payload. */
const STATUS_BODY = {
  accounts: [
    { email: "a@example.com", unified5h: 0.04, unified7d: 0.05, unifiedStatus: "allowed" },
    { email: "b@example.com", unified5h: 0.01, unified7d: 0.3, unifiedStatus: "allowed" },
  ],
};

describe("teamclaude quota reader", () => {
  it("takes the worst utilization across accounts for each window", async () => {
    const snapshot = await readQuotaSnapshot({
      config: gate(),
      http: client({ status: 200, body: STATUS_BODY }),
      apiKey: "key",
      now: () => NOW,
    });
    expect(snapshot.windows).toEqual({ unified5h: 0.04, unified7d: 0.3 });
    expect(snapshot.maxUtilization).toBe(0.3);
    expect(snapshot.error).toBeNull();
  });

  it("treats the values as fractions, not percentages", async () => {
    const snapshot = await readQuotaSnapshot({
      config: gate(),
      http: client({ status: 200, body: { accounts: [{ unified7d: 0.97 }] } }),
      apiKey: "key",
      now: () => NOW,
    });
    // 0.97 means 97% consumed. Anything that read this as 0.97% would never gate.
    expect(snapshot.maxUtilization).toBe(0.97);
  });

  it("sends the key as x-api-key, because the endpoint requires auth", async () => {
    const http = client({ status: 200, body: STATUS_BODY });
    await readQuotaSnapshot({ config: gate(), http, apiKey: "secret-value", now: () => NOW });
    expect(http.calls[0]?.headers).toEqual({ "x-api-key": "secret-value" });
  });

  it("reports a credential rejection as an explanation, not a crash", async () => {
    const snapshot = await readQuotaSnapshot({
      config: gate(),
      http: client({ status: 401, body: null }),
      apiKey: null,
      now: () => NOW,
    });
    expect(snapshot.maxUtilization).toBeNull();
    expect(snapshot.error).toContain("apiKeySecretRef");
  });

  it("degrades to an unknown gate rather than throwing when the endpoint is unreachable", async () => {
    const snapshot = await readQuotaSnapshot({
      config: gate(),
      http: {
        async request() {
          throw new Error("ECONNREFUSED");
        },
      },
      apiKey: "key",
      now: () => NOW,
    });
    // A null utilization leaves the gate at `ok`: an unreadable quota endpoint
    // must not silently pause every company's Claude work.
    expect(snapshot.maxUtilization).toBeNull();
    expect(snapshot.error).toContain("ECONNREFUSED");
  });

  it("says so when the configured windows are absent from the response", async () => {
    const snapshot = await readQuotaSnapshot({
      config: gate({ windows: ["unified7dOpus"] }),
      http: client({ status: 200, body: STATUS_BODY }),
      apiKey: "key",
      now: () => NOW,
    });
    expect(snapshot.maxUtilization).toBeNull();
    expect(snapshot.error).toContain("unified7dOpus");
  });

  it("does not call the endpoint at all when the gate is off", async () => {
    const http = client({ status: 200, body: STATUS_BODY });
    const snapshot = await readQuotaSnapshot({
      config: gate({ enabled: false }),
      http,
      apiKey: "key",
      now: () => NOW,
    });
    expect(http.calls).toHaveLength(0);
    expect(snapshot.error).toContain("disabled");
  });

  it("refuses to call an unconfigured URL", async () => {
    const http = client({ status: 200, body: STATUS_BODY });
    const snapshot = await readQuotaSnapshot({
      config: gate({ statusUrl: "" }),
      http,
      apiKey: "key",
      now: () => NOW,
    });
    expect(http.calls).toHaveLength(0);
    expect(snapshot.error).toContain("statusUrl");
  });
});
