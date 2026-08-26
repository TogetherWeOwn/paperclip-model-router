import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import { validateSecretRefShape } from "../src/config/secret-ref.js";
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

  it("validates HTTPS URLs and forbidden headers at runtime", () => {
    const config = resolveConfig(readFixture("company-a"));
    expect(validateUpstreamConfig(config.upstream)).toEqual([]);
    config.upstream.baseUrl = "https://user:pass@example.com/path?secret=yes";
    config.upstream.extraHeaders.Authorization = "not-allowed";
    config.upstream.extraHeaders["Accept-Encoding"] = "gzip";
    const errors = validateUpstreamConfig(config.upstream).join(" ");
    expect(errors).toContain("credentials");
    expect(errors).toContain("query or fragment");
    expect(errors).toContain("Authorization");
    expect(errors).toContain("Accept-Encoding");
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
