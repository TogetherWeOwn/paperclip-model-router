import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import { validateSecretRefShape } from "../src/config/secret-ref.js";
import { MAX_REQUEST_TIMEOUT_MS } from "../src/config/upstream-constraints.js";
import { validateUpstreamConfig } from "../src/inference/adapters.js";
import { readFixture } from "./helpers.js";

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvInstance = { addFormat(name: string, definition: { validate: () => boolean }): void; compile(schema: object): ValidateFn };
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;
const Ajv = ((AjvImport as unknown as { default?: unknown }).default ?? AjvImport) as unknown as AjvConstructor;
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as unknown as (ajv: AjvInstance) => void;

function hostValidator(): ValidateFn {
  const ajv = new Ajv({ allErrors: true, logger: false });
  addFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(ROUTER_CONFIG_SCHEMA as unknown as object);
}

describe("compatible-upstream config", () => {
  it("compiles and accepts both shipped company configs", () => {
    const validate = hostValidator();
    for (const fixture of ["company-a", "company-b"]) {
      expect(validate(readFixture(fixture)), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects provider, quota, raw credential, and transport override fields", () => {
    const validate = hostValidator();
    expect(validate({ providers: {} })).toBe(false);
    expect(validate({ deprecatedQuotaPolicy: {} })).toBe(false);
    expect(validate({ upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: "raw" } })).toBe(false);
    expect(validate({ upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example", credentialSecretRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, connectTimeoutMs: 1000 } })).toBe(false);
    expect(validate({ upstream: { protocol: "openai-chat-completions", baseUrl: "https://user:pass@x.example/path", credentialSecretRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } })).toBe(false);
    expect(validate({ upstream: { protocol: "openai-chat-completions", baseUrl: "https://x.example/path?token=value", credentialSecretRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } })).toBe(false);
  });

  it("closes the secret reference and projection class", () => {
    expect(validateSecretRefShape({ type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "upstream.credentialSecretRef")).toBeNull();
    expect(validateSecretRefShape({ type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", value: "hidden" }, "upstream.credentialSecretRef")).toContain("unexpected");
    expect(validateSecretRefShape({ type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectionClass: "other" }, "upstream.credentialSecretRef")).toContain("projectionClass");
  });

  it("validates HTTPS URLs, literal hosts, bounds, and fixed headers at runtime", () => {
    const config = resolveConfig(readFixture("company-a"));
    expect(validateUpstreamConfig(config.upstream)).toEqual([]);
    config.upstream.baseUrl = "https://user:pass@100.64.0.1/path?secret=yes";
    config.upstream.requestTimeoutMs = 999;
    config.upstream.maxResponseBytes = 16_777_217;
    config.upstream.extraHeaders.Authorization = "not-allowed";
    config.upstream.extraHeaders["aNtHrOpIc-BeTa"] = "unsafe";
    config.upstream.extraHeaders["content-TYPE"] = "text/plain";
    config.upstream.extraHeaders.Accept = "text/event-stream";
    config.upstream.extraHeaders["Accept-Encoding"] = "gzip";
    const errors = validateUpstreamConfig(config.upstream).join(" ");
    expect(errors).toContain("credentials");
    expect(errors).toContain("query or fragment");
    expect(errors).toContain("private or reserved literal");
    expect(errors).toContain("requestTimeoutMs");
    expect(errors).toContain("maxResponseBytes");
    for (const header of ["Authorization", "aNtHrOpIc-BeTa", "content-TYPE", "Accept", "Accept-Encoding"]) {
      expect(errors).toContain(header);
    }
  });

  it("accepts a timeout long enough for a thinking model, and still rejects an absurd one", () => {
    // TOG-1035: 120s was the operator's stated floor; anything at or under the
    // ceiling must now pass the same runtime validator that used to refuse it.
    const config = resolveConfig(readFixture("company-a"));
    config.upstream.requestTimeoutMs = 120_000;
    expect(validateUpstreamConfig(config.upstream)).toEqual([]);
    config.upstream.requestTimeoutMs = MAX_REQUEST_TIMEOUT_MS + 1;
    expect(validateUpstreamConfig(config.upstream).join(" ")).toContain("requestTimeoutMs");
  });

  it("keeps a per-model override out of the table when it is not a number", () => {
    const config = resolveConfig({
      ...readFixture("company-a"),
      models: [
        { id: "slow-thinker", tier: "standard", quality: 50, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1000, requestTimeoutMs: 180_000 },
        { id: "junk-override", tier: "standard", quality: 50, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1000, requestTimeoutMs: "soon" },
        { id: "inherits", tier: "standard", quality: 50, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1000 },
      ],
    });
    const byId = new Map(config.models.map((model) => [model.id, model]));
    expect(byId.get("slow-thinker")?.requestTimeoutMs).toBe(180_000);
    // Absent rather than defaulted, so the transport can tell override from inherit.
    expect(byId.get("junk-override")?.requestTimeoutMs).toBeUndefined();
    expect(byId.get("inherits")?.requestTimeoutMs).toBeUndefined();
  });

  it.each([
    "https://0.0.0.0",
    "https://100.127.255.255",
    "https://192.0.2.1",
    "https://198.18.0.1",
    "https://203.0.113.1",
    "https://[::1]",
    "https://[64:ff9b::1]",
    "https://[64:ff9b::ffff:ffff]",
    "https://[64:ff9b:1::1]",
    "https://[2001:db8::1]",
    "https://[3fff::1]",
    "https://[3fff:fff::1]",
    "https://[::ffff:127.0.0.1]",
  ])("rejects reserved literal upstream %s", (baseUrl) => {
    const config = resolveConfig(readFixture("company-a"));
    config.upstream.baseUrl = baseUrl;
    expect(validateUpstreamConfig(config.upstream)).toContain("upstream.baseUrl must not use a private or reserved literal address");
  });

  it.each([
    "https://[64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[64:ff9b:0:0:0:1::]",
    "https://[3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[3fff:1000::1]",
    "https://[4000::1]",
  ])("allows global literal upstream boundary %s", (baseUrl) => {
    const config = resolveConfig(readFixture("company-a"));
    config.upstream.baseUrl = baseUrl;
    expect(validateUpstreamConfig(config.upstream)).toEqual([]);
  });

  it("fails closed for unknown persisted protocols", () => {
    const config = resolveConfig({
      upstream: {
        protocol: "future-provider-wire",
        baseUrl: "https://x.example",
      },
    });
    expect(config.upstream.protocol).toBeNull();
    expect(validateUpstreamConfig(config.upstream)).toContain("upstream.protocol is not supported");
  });

  it("accepts provider-neutral capacity mappings and defaults shadow-first", () => {
    const raw = readFixture("company-a") as Record<string, unknown>;
    raw.capacityRouting = {
      enabled: true,
      sources: [{
        id: "capacity",
        statusUrl: "https://capacity.example/status",
        modelIds: ["minimax-m2.5"],
        windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: ["resets7dAt"] }],
      }],
    };
    const validate = hostValidator();
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
    expect(resolveConfig(raw).capacityRouting).toMatchObject({
      enabled: true,
      mode: "shadow",
      // TOG-1040: absent telemetry must degrade routing, not deny service.
      unknownTelemetry: "fail-open",
      conserveUtilization: 0.6,
      avoidUtilization: 0.8,
    });
  });

  it("keeps fail-closed and exclude-lane available as explicit opt-ins, and ignores junk", () => {
    const raw = readFixture("company-a") as Record<string, unknown>;
    const withPolicy = (unknownTelemetry: unknown) => ({
      ...raw,
      capacityRouting: {
        enabled: true,
        unknownTelemetry,
        sources: [{
          id: "capacity",
          statusUrl: "https://capacity.example/status",
          modelIds: ["minimax-m2.5"],
          windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: ["resets7dAt"] }],
        }],
      },
    });
    expect(resolveConfig(withPolicy("fail-closed")).capacityRouting.unknownTelemetry).toBe("fail-closed");
    expect(resolveConfig(withPolicy("exclude-lane")).capacityRouting.unknownTelemetry).toBe("exclude-lane");
    expect(resolveConfig(withPolicy("nonsense")).capacityRouting.unknownTelemetry).toBe("fail-open");
    expect(resolveConfig(withPolicy(undefined)).capacityRouting.unknownTelemetry).toBe("fail-open");
    // fail-closed remains a legal config value at the host boundary, not just in the resolver.
    expect(hostValidator()(withPolicy("fail-closed"))).toBe(true);
    expect(hostValidator()(withPolicy("nonsense"))).toBe(false);
  });

  it("rejects raw credentials and unsafe URLs in capacity sources", () => {
    const raw = readFixture("company-a") as Record<string, unknown>;
    raw.capacityRouting = {
      enabled: true,
      sources: [{
        id: "capacity",
        statusUrl: "https://user:pass@capacity.example/status?token=x",
        modelIds: ["minimax-m2.5"],
        apiKeySecretRef: "raw-secret",
        windows: [{ name: "weekly", utilizationFields: ["used7d"] }],
      }],
    };
    expect(hostValidator()(raw)).toBe(false);
  });

  it("fills bounded transport defaults", () => {
    const config = resolveConfig({
      upstream: {
        protocol: "anthropic-messages",
        baseUrl: "https://x.example",
        credentialSecretRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      },
    });
    expect(config.upstream).toMatchObject({ requestTimeoutMs: 25000, maxResponseBytes: 8388608, extraHeaders: {} });
  });
});
