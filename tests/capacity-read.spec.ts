import { describe, expect, it, vi } from "vitest";
import { readCapacitySource } from "../src/capacity/read.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";

const source: CapacitySourceConfig = {
  id: "capacity", statusUrl: "https://capacity.example/status", apiKeySecretRef: null,
  modelIds: ["model-a"], healthFields: ["status"],
  requestTimeoutMs: 5000, maxResponseBytes: 262144,
  windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: ["reset"] }],
};
const now = () => "2026-09-04T12:00:00.000Z";

describe("capacity telemetry reader", () => {
  it("makes one bounded GET with fixed safe request controls", async () => {
    const request = vi.fn(async () => ({ status: 200, contentType: "application/json; charset=utf-8", body: { rows: [{ lane: "a", status: "ok", used: 0.2 }] }, responseBytes: 40, redirected: false }));
    const result = await readCapacitySource({ source, http: { request }, apiKey: "resolved", now });
    expect(result.error).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: source.statusUrl, method: "GET", redirect: "manual", timeoutMs: 5000, maxResponseBytes: 262144,
      headers: { Accept: "application/json", "Accept-Encoding": "identity", "x-api-key": "resolved" },
    }));
  });

  it.each([
    ["redirect", { status: 302, contentType: "application/json", body: {}, responseBytes: 2, redirected: true }, "capacity-redirect-refused"],
    ["oversized", { status: 200, contentType: "application/json; charset=utf-8", body: {}, responseBytes: 262145, redirected: false }, "capacity-response-too-large"],
    ["auth", { status: 401, contentType: "application/json", body: {}, responseBytes: 2, redirected: false }, "capacity-authentication-failed"],
    ["http", { status: 503, contentType: "application/json", body: {}, responseBytes: 2, redirected: false }, "capacity-http-failed"],
    ["json", { status: 200, contentType: "application/json; charset=utf-8", body: null, responseBytes: 1, redirected: false }, "capacity-invalid-json"],
  ])("returns bounded code for %s", async (_label, response, code) => {
    const result = await readCapacitySource({ source, http: { request: async () => response }, apiKey: null, now });
    expect(result).toMatchObject({ evidence: [], error: code });
  });

  it.each([null, "text/html", "text/plain; charset=utf-8"])("rejects unexpected media type %s", async (contentType) => {
    const result = await readCapacitySource({ source, http: { request: async () => ({ status: 200, contentType, body: { rows: [] }, responseBytes: 11, redirected: false }) }, apiKey: null, now });
    expect(result.error).toBe("capacity-unexpected-media-type");
  });

  it("does not expose thrown exception content", async () => {
    const result = await readCapacitySource({ source, http: { request: async () => { throw new Error("secret URL body"); } }, apiKey: null, now });
    expect(result.error).toBe("capacity-request-failed");
    expect(JSON.stringify(result)).not.toContain("secret URL body");
  });
});
