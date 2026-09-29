/**
 * TOG-7884 (gap G6): SSRF conformance for DNS rebinding on the upstream +
 * capacity paths.
 *
 * Config validation only sees IP literals (https + no userinfo + literal-host
 * check); a DNS name resolving to 10.x / 169.254.x / ::1 sails through it.
 * The request-time guard (`checkResolvedHost`, wired into
 * `invokeCompatibleUpstream` and `readCapacitySource`) resolves the request
 * hostname and refuses when ANY answer is private/reserved. These tests pin
 * that with a mocked resolver: rebinding + direct-IP literals on both paths,
 * refusal as a non-retryable error, and proof no credential or header leaves
 * the process (fetch/request spy never fires, result never echoes secrets).
 */
import { describe, expect, it, vi } from "vitest";

import { readCapacitySource } from "../src/capacity/read.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { checkResolvedHost } from "../src/config/upstream-constraints.js";
import { invokeCompatibleUpstream } from "../src/inference/transport.js";
import type { InvokeRequest } from "../src/inference/types.js";
import { fixtureConfig } from "./helpers.js";

const now = () => "2026-09-04T12:00:00.000Z";

const invokeRequest: InvokeRequest = {
  task: {},
  messages: [{ role: "user", content: "hi" }],
  maxOutputTokens: 10,
};

function upstreamConfig(baseUrl: string) {
  return { ...fixtureConfig("company-a").upstream, baseUrl };
}

function capacitySource(statusUrl: string): CapacitySourceConfig {
  return {
    id: "capacity",
    statusUrl,
    apiKeySecretRef: null,
    modelIds: ["model-a"],
    healthFields: ["status"],
    requestTimeoutMs: 5000,
    maxResponseBytes: 262144,
    windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: ["reset"] }],
  };
}

function openAiSuccess(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "echo",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function capacitySuccessBody() {
  return { rows: [{ lane: "a", status: "ok", used: 0.2 }] };
}

describe("TOG-7884: resolved-host guard unit", () => {
  it.each([
    ["rfc1918 10.x", "10.1.2.3"],
    ["link-local 169.254.x", "169.254.169.254"],
    ["loopback v6 ::1", "::1"],
  ])("refuses literal %s without touching DNS", async (_label, literal) => {
    const resolve = vi.fn(async (_host: string): Promise<string[]> => {
      throw new Error("resolver must not be called for literals");
    });
    const verdict = await checkResolvedHost(literal, resolve);
    expect(verdict).toEqual({ allowed: false, reason: "reserved-literal" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("allows a literal public IP without touching DNS", async () => {
    const resolve = vi.fn(async (_host: string): Promise<string[]> => ["10.0.0.1"]);
    const verdict = await checkResolvedHost("93.184.216.34", resolve);
    expect(verdict).toEqual({ allowed: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["rfc1918 10.x", "10.1.2.3"],
    ["link-local 169.254.x", "169.254.169.254"],
    ["loopback v6 ::1", "::1"],
  ])("refuses a DNS name resolving to %s", async (_label, address) => {
    const resolve = vi.fn(async (_host: string): Promise<string[]> => [address]);
    const verdict = await checkResolvedHost("rebind.example", resolve);
    expect(verdict).toEqual({ allowed: false, reason: "reserved-resolved" });
    expect(resolve).toHaveBeenCalledWith("rebind.example");
  });

  it("refuses when ANY answer is reserved (rebinding / split-horizon)", async () => {
    const resolve = vi.fn(async (_host: string): Promise<string[]> => ["93.184.216.34", "10.0.0.5"]);
    const verdict = await checkResolvedHost("rebind.example", resolve);
    expect(verdict).toEqual({ allowed: false, reason: "reserved-resolved" });
  });

  it("allows an all-public answer set", async () => {
    const resolve = vi.fn(async (_host: string): Promise<string[]> => ["93.184.216.34", "151.101.1.69"]);
    const verdict = await checkResolvedHost("upstream.example", resolve);
    expect(verdict).toEqual({ allowed: true });
  });

  it("falls through as allowed when the name does not resolve (DNS outage is not a URL refusal)", async () => {
    const resolve = vi.fn(async (_host: string): Promise<string[]> => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND rebind.example"), { code: "ENOTFOUND" });
    });
    const verdict = await checkResolvedHost("rebind.example", resolve);
    expect(verdict).toEqual({ allowed: true });
  });
});

describe("TOG-7884: upstream path refuses rebound names", () => {
  it.each([
    ["rfc1918 10.x", "10.1.2.3"],
    ["link-local 169.254.x", "169.254.169.254"],
    ["loopback v6 ::1", "::1"],
  ])("refuses a name resolving to %s without sending anything", async (_label, address) => {
    const credential = "resolved-secret-aa";
    const fetch = vi.fn(async (): Promise<Response> => openAiSuccess());
    const resolveHostAddresses = vi.fn(async (_host: string): Promise<string[]> => [address]);
    const result = await invokeCompatibleUpstream({
      http: { fetch },
      config: upstreamConfig("https://rebind.example/api"),
      credential,
      request: invokeRequest,
      modelId: "m",
      resolveHostAddresses,
    });
    expect(result.error).toMatchObject({ code: "upstream-url-rejected", retryable: false });
    expect(result.response).toBeNull();
    expect(resolveHostAddresses).toHaveBeenCalledWith("rebind.example");
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("refuses a rebinding answer set (public first, private second) without sending anything", async () => {
    const credential = "resolved-secret-ab";
    const fetch = vi.fn(async (): Promise<Response> => openAiSuccess());
    const result = await invokeCompatibleUpstream({
      http: { fetch },
      config: upstreamConfig("https://rebind.example/api"),
      credential,
      request: invokeRequest,
      modelId: "m",
      resolveHostAddresses: async () => ["93.184.216.34", "10.0.0.5"],
    });
    expect(result.error).toMatchObject({ code: "upstream-url-rejected", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it.each([
    ["rfc1918 literal", "https://10.1.2.3/api"],
    ["link-local literal", "https://169.254.169.254/api"],
    ["loopback literal", "https://[::1]/api"],
  ])("refuses direct-IP literal %s without touching DNS or the wire", async (_label, baseUrl) => {
    const credential = "resolved-secret-ba";
    const fetch = vi.fn(async (): Promise<Response> => openAiSuccess());
    const resolveHostAddresses = vi.fn(async (_host: string): Promise<string[]> => ["93.184.216.34"]);
    const result = await invokeCompatibleUpstream({
      http: { fetch },
      config: upstreamConfig(baseUrl),
      credential,
      request: invokeRequest,
      modelId: "m",
      resolveHostAddresses,
    });
    expect(result.error).toMatchObject({ code: "upstream-url-rejected", retryable: false });
    expect(resolveHostAddresses).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("still sends when the name resolves to a public address", async () => {
    const fetch = vi.fn(async (): Promise<Response> => openAiSuccess());
    const result = await invokeCompatibleUpstream({
      http: { fetch },
      config: upstreamConfig("https://rebind.example/api"),
      credential: "resolved-value",
      request: invokeRequest,
      modelId: "m",
      resolveHostAddresses: async () => ["93.184.216.34"],
    });
    expect(result.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reclassify a DNS outage as a URL refusal", async () => {
    const fetch = vi.fn(async (): Promise<Response> => openAiSuccess());
    const result = await invokeCompatibleUpstream({
      http: { fetch },
      config: upstreamConfig("https://rebind.example/api"),
      credential: "resolved-value",
      request: invokeRequest,
      modelId: "m",
      resolveHostAddresses: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND rebind.example"), { code: "ENOTFOUND" });
      },
    });
    expect(result.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("TOG-7884: capacity path refuses rebound names", () => {
  it.each([
    ["rfc1918 10.x", "10.1.2.3"],
    ["link-local 169.254.x", "169.254.169.254"],
    ["loopback v6 ::1", "::1"],
  ])("refuses a name resolving to %s without sending the api key", async (_label, address) => {
    const apiKey = "resolved-secret-ca";
    const request = vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      body: capacitySuccessBody(),
      responseBytes: 40,
      redirected: false,
    }));
    const resolveHostAddresses = vi.fn(async (_host: string): Promise<string[]> => [address]);
    const result = await readCapacitySource({
      source: capacitySource("https://telemetry.example/status"),
      http: { request },
      apiKey,
      now,
      resolveHostAddresses,
    });
    expect(result).toMatchObject({ evidence: [], error: "capacity-url-rejected" });
    expect(resolveHostAddresses).toHaveBeenCalledWith("telemetry.example");
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("refuses a rebinding answer set (public first, private second) without sending the api key", async () => {
    const apiKey = "resolved-secret-cb";
    const request = vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      body: capacitySuccessBody(),
      responseBytes: 40,
      redirected: false,
    }));
    const result = await readCapacitySource({
      source: capacitySource("https://telemetry.example/status"),
      http: { request },
      apiKey,
      now,
      resolveHostAddresses: async () => ["93.184.216.34", "169.254.10.20"],
    });
    expect(result).toMatchObject({ evidence: [], error: "capacity-url-rejected" });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([
    ["rfc1918 literal", "https://10.1.2.3/status"],
    ["link-local literal", "https://169.254.169.254/status"],
    ["loopback literal", "https://[::1]/status"],
  ])("refuses direct-IP literal %s without touching DNS or the wire", async (_label, statusUrl) => {
    const apiKey = "resolved-secret-cc";
    const request = vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      body: capacitySuccessBody(),
      responseBytes: 40,
      redirected: false,
    }));
    const resolveHostAddresses = vi.fn(async (_host: string): Promise<string[]> => ["93.184.216.34"]);
    const result = await readCapacitySource({
      source: capacitySource(statusUrl),
      http: { request },
      apiKey,
      now,
      resolveHostAddresses,
    });
    expect(result).toMatchObject({ evidence: [], error: "capacity-url-rejected" });
    expect(resolveHostAddresses).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("still fetches when the name resolves to a public address", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: capacitySuccessBody(),
      responseBytes: 40,
      redirected: false,
    }));
    const result = await readCapacitySource({
      source: capacitySource("https://telemetry.example/status"),
      http: { request },
      apiKey: "resolved",
      now,
      resolveHostAddresses: async () => ["93.184.216.34"],
    });
    expect(result.error).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not reclassify a DNS outage as a URL refusal", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: capacitySuccessBody(),
      responseBytes: 40,
      redirected: false,
    }));
    const result = await readCapacitySource({
      source: capacitySource("https://telemetry.example/status"),
      http: { request },
      apiKey: "resolved",
      now,
      resolveHostAddresses: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND telemetry.example"), { code: "ENOTFOUND" });
      },
    });
    expect(result.error).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
