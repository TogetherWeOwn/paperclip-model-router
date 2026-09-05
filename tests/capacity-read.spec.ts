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

/**
 * TOG-977: the dispatch itself, over the transport that actually runs.
 *
 * `tests/capacity.spec.ts` exercises `evidenceFromContract` directly. These
 * tests assert the layer above it — that a body claiming to be a contract
 * snapshot reaches the contract path rather than the legacy tree walk, and that
 * a vendor body still reaches the tree walk. A correct adapter wired to nothing
 * would pass the former suite and fail this one.
 */
describe("readCapacitySource dispatch (contract vs legacy)", () => {
  function serve(body: unknown) {
    return readCapacitySource({
      source,
      http: { request: async () => ({ status: 200, contentType: "application/json; charset=utf-8", body, responseBytes: 400, redirected: false }) },
      apiKey: null,
      now,
    });
  }

  const OBSERVED = "2026-09-04T12:00:00.000Z"; // equal to `now`, so never stale

  function snapshot(over: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      observedAt: OBSERVED,
      staleAfterSeconds: 300,
      telemetry: "available",
      reasonCode: null,
      models: {
        "model-a": {
          serviceable: true, state: "degraded", utilization: 0.71, remainingFraction: 0.29,
          resetsAt: "2026-09-04T14:00:00.000Z", resetInSeconds: 7200, observationQuality: "measured",
          windows: [{ window: "five-hour", utilization: 0.71, resetsAt: "2026-09-04T14:00:00.000Z", resetInSeconds: 7200 }],
        },
      },
      ...over,
    };
  }

  it("routes a contract body to the keyed contract path", async () => {
    const result = await serve(snapshot());
    expect(result).toMatchObject({ telemetry: "available", reasonCode: null, error: null });
    // One row for the one configured id, carrying that id's own number. The
    // legacy walk would emit two (record + nested window entry).
    expect(result.evidence.map((e) => [e.modelId, e.utilization])).toEqual([["model-a", 0.71]]);
    expect(result.evidence[0]!.health).toBe("degraded");
  });

  it("rejects an unimplemented schemaVersion instead of best-effort parsing it", async () => {
    const result = await serve(snapshot({ schemaVersion: 2 }));
    expect(result).toMatchObject({ evidence: [], telemetry: "unavailable", reasonCode: "capacity-schema-version-unsupported" });
  });

  it("reads a producer outage as an outage, not as unconstrained capacity", async () => {
    const result = await serve({
      schemaVersion: 1, observedAt: OBSERVED, staleAfterSeconds: 300,
      telemetry: "unavailable", reasonCode: "upstream-unreachable", models: {},
    });
    expect(result).toMatchObject({ evidence: [], telemetry: "unavailable", reasonCode: "capacity-producer-unavailable" });
  });

  it("reads a healthy-empty snapshot as available, distinguishably from that outage", async () => {
    const result = await serve(snapshot({ models: {} }));
    expect(result.evidence).toEqual([]);
    // Same zero rows as the outage above; the difference is carried by the
    // fields, which is the whole of contract §4.
    expect(result).toMatchObject({ telemetry: "available", reasonCode: null, error: null });
  });

  it("treats a stale snapshot as unavailable even though it parses", async () => {
    const result = await serve(snapshot({ observedAt: "2026-09-04T11:50:00.000Z" })); // 600s > 300s
    expect(result).toMatchObject({ evidence: [], telemetry: "unavailable", reasonCode: "capacity-snapshot-stale" });
  });

  it("still routes a vendor body with no schemaVersion down the legacy path", async () => {
    const result = await serve({ rows: [{ lane: "a", status: "ok", used: 0.2 }] });
    expect(result.error).toBeNull();
    expect(result.evidence.map((e) => [e.modelId, e.utilization])).toEqual([["model-a", 0.2]]);
    // The legacy path labels the lane from the payload; the contract path uses
    // the fixed "model" token. That is how we know which one ran.
    expect(result.evidence[0]!.laneLabel).not.toBe("model");
  });
});
