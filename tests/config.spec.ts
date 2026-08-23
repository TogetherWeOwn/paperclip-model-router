/**
 * The host validates a company's submitted config with Ajv against the
 * manifest's `instanceConfigSchema`, registering `secret-ref` as a permissive
 * format. These tests run the same Ajv setup, so a schema mistake fails here
 * rather than at the moment an operator tries to configure a company.
 */

import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import { readFixture } from "./helpers.js";

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvInstance = {
  addFormat(name: string, definition: { validate: () => boolean }): void;
  compile(schema: object): ValidateFn;
};
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

// ajv and ajv-formats ship CJS. Under NodeNext the imported binding is the
// module namespace, so the real export hides under `.default`. The host does
// the same unwrap in `plugin-config-validator.ts`.
const Ajv = ((AjvImport as unknown as { default?: unknown }).default ??
  AjvImport) as unknown as AjvConstructor;
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ??
  addFormatsImport) as unknown as (ajv: AjvInstance) => void;

function hostValidator(): ValidateFn {
  // Same construction as the host's `validateInstanceConfig`. `logger: false`
  // is the one difference: the host logs a benign Ajv strictTypes note for
  // `format: "secret-ref"` on a non-string field, which is expected — see
  // docs/decisions/0004-secret-references-not-secrets.md.
  const ajv = new Ajv({ allErrors: true, logger: false });
  addFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(ROUTER_CONFIG_SCHEMA as unknown as object);
}

describe("instanceConfigSchema", () => {
  it("compiles under the host's Ajv configuration", () => {
    expect(() => hostValidator()).not.toThrow();
  });

  it("accepts both shipped example configs", () => {
    const validate = hostValidator();
    for (const name of ["company-a", "company-b"]) {
      const valid = validate(readFixture(name));
      expect(validate.errors ?? [], `${name}: ${JSON.stringify(validate.errors)}`).toEqual([]);
      expect(valid).toBe(true);
    }
  });

  it("accepts an empty config, so a company can be configured incrementally", () => {
    expect(hostValidator()({})).toBe(true);
  });

  it("rejects an unknown top-level key rather than silently ignoring it", () => {
    expect(hostValidator()({ modelTable: [] })).toBe(false);
  });

  it("rejects a model row that is missing a price", () => {
    const validate = hostValidator();
    const valid = validate({
      models: [{ id: "x", family: "y", tier: "small", quality: 10, contextWindow: 1000 }],
    });
    expect(valid).toBe(false);
  });

  it("rejects an unknown tier", () => {
    expect(
      hostValidator()({
        models: [
          {
            id: "x",
            family: "y",
            tier: "ultra",
            quality: 10,
            costPerMTokIn: 1,
            costPerMTokOut: 1,
            contextWindow: 1000,
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a quality score outside 0-100", () => {
    expect(
      hostValidator()({
        models: [
          {
            id: "x",
            family: "y",
            tier: "small",
            quality: 140,
            costPerMTokIn: 1,
            costPerMTokOut: 1,
            contextWindow: 1000,
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a pasted raw credential at the secret-ref field", () => {
    // This is the schema-level guarantee behind "no secrets, ever": a raw key
    // string cannot even be stored in a company's config.
    expect(hostValidator()({ quotaGate: { apiKeySecretRef: "sk-live-not-a-reference" } })).toBe(false);
  });

  it("accepts a secret reference binding object and an explicit null", () => {
    const validate = hostValidator();
    expect(
      validate({
        quotaGate: {
          apiKeySecretRef: {
            type: "secret_ref",
            secretId: "77777777-7777-4777-8777-777777777777",
            version: "latest",
          },
        },
      }),
    ).toBe(true);
    expect(validate({ quotaGate: { apiKeySecretRef: null } })).toBe(true);
  });

  it("marks the teamclaude key as a secret reference, never a raw value", () => {
    const property = (ROUTER_CONFIG_SCHEMA.properties.quotaGate.properties as Record<string, { format?: string }>)
      .apiKeySecretRef;
    expect(property?.format).toBe("secret-ref");
  });
});

describe("resolveConfig", () => {
  it("fills every field from an empty object", () => {
    const config = resolveConfig({});
    expect(config.routing.enabled).toBe(true);
    expect(config.providers.claudePaygEnabled).toBe(false);
    expect(config.providers.claudeFamilyProvider).toBe("teamclaude");
    expect(config.models).toEqual([]);
    expect(config.quotaGate.enabled).toBe(false);
    expect(config.budget.haltFraction).toBe(0.95);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "nope", [], { models: "not-an-array" }]) {
      expect(() => resolveConfig(junk)).not.toThrow();
    }
    expect(resolveConfig({ models: "not-an-array" }).models).toEqual([]);
  });

  it("defaults Claude PAYG to off even when the key is present but not a boolean", () => {
    expect(resolveConfig({ providers: { claudePaygEnabled: "yes" } }).providers.claudePaygEnabled).toBe(
      false,
    );
  });

  it("drops a model row with no id rather than inventing one", () => {
    expect(resolveConfig({ models: [{ family: "x" }, { id: "keep", family: "y" }] }).models).toHaveLength(
      1,
    );
  });

  it("round-trips both example configs without losing a field", () => {
    for (const name of ["company-a", "company-b"]) {
      const raw = readFixture(name);
      const resolved = resolveConfig(raw);
      expect(resolved.models).toHaveLength((raw.models as unknown[]).length);
      expect(resolved.taskClasses).toHaveLength((raw.taskClasses as unknown[]).length);
    }
  });
});
