/**
 * TOG-7880 (gap G1): duplicate model ids must fail closed at config load.
 *
 * A duplicated id double-counts one lane in every survivor pool
 * (select.ts) and makes rejections ambiguous. The refusal lives in
 * resolveConfig — the load path every invoke and capacity refresh shares —
 * so a duped table can never be served, and onValidateConfig surfaces it as
 * a structured refusal naming both entries instead of a thrown 500.
 *
 * The fold is case-insensitive on purpose: the engine joins evidence on
 * exact `===` (aggregateEvidenceFor) while the TOG-7163 grouped-quota
 * projection matches `trim().toLowerCase()`, so a case-variant dupe is
 * simultaneously two lanes on one path and one lane on another.
 */
import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import { createPlugin } from "../src/worker.js";
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

function model(id: string): Record<string, unknown> {
  return { id, tier: "standard", quality: 50, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1000 };
}

function baseRaw(): Record<string, unknown> {
  return structuredClone(readFixture("company-a")) as Record<string, unknown>;
}

function withModels(models: Array<Record<string, unknown>>): Record<string, unknown> {
  return { ...baseRaw(), models };
}

async function validate(raw: Record<string, unknown>) {
  const { definition } = createPlugin();
  const result = await definition.onValidateConfig!(raw);
  return { ok: result.ok, errors: result.errors ?? [], warnings: result.warnings ?? [] };
}

describe("TOG-7880: duplicate model ids fail closed", () => {
  it("resolveConfig throws on an exact dupe, naming both entries", () => {
    const raw = withModels([model("dup-lane"), model("other-lane"), model("dup-lane")]);
    expect(() => resolveConfig(raw)).toThrow(
      'duplicate model id "dup-lane" at models[2] (first seen as "dup-lane" at models[0])',
    );
  });

  it("resolveConfig throws on a case-variant dupe, naming both spellings", () => {
    const raw = withModels([model("MiniMax-M2.5"), model("other-lane"), model("minimax-m2.5")]);
    expect(() => resolveConfig(raw)).toThrow(
      'duplicate model id "minimax-m2.5" at models[2] (first seen as "MiniMax-M2.5" at models[0])',
    );
  });

  it("resolveConfig still accepts a clean table, and ignores non-record/empty entries", () => {
    const raw = withModels([model("a"), model("b")]);
    (raw.models as unknown[]).push(null, { id: "" }, { tier: "standard" });
    expect(resolveConfig(raw).models.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("onValidateConfig refuses a duped table as ok:false with both entries named", async () => {
    const result = await validate(withModels([model("dup-lane"), model("dup-lane")]));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'duplicate model id "dup-lane" at models[1] (first seen as "dup-lane" at models[0])',
    );
  });

  it("onValidateConfig refuses a case-variant dupe with both spellings named", async () => {
    const result = await validate(withModels([model("Foo-Lane"), model("foo-lane")]));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'duplicate model id "foo-lane" at models[1] (first seen as "Foo-Lane" at models[0])',
    );
  });

  it("a fallback naming a duped id reports the dupe, not a passing fallback", async () => {
    const raw = withModels([model("dup-lane"), model("dup-lane")]);
    (raw.routing as Record<string, unknown>).fallbackModelId = "dup-lane";
    const result = await validate(raw);
    expect(result.ok).toBe(false);
    // The dupe error must fire even though the fallback id IS in the table —
    // the fallback-exists check must never mask the ambiguity.
    expect(result.errors.join("\n")).toContain('duplicate model id "dup-lane"');
  });

  it("a fallback naming a unique id still validates", async () => {
    const raw = withModels([model("a"), model("b")]);
    (raw.routing as Record<string, unknown>).fallbackModelId = "b";
    expect((await validate(raw)).ok).toBe(true);
  });

  it("fallback matching stays exact: a case-variant fallback is still unknown", async () => {
    const raw = withModels([model("foo-lane")]);
    (raw.routing as Record<string, unknown>).fallbackModelId = "Foo-Lane";
    const result = await validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "routing.fallbackModelId Foo-Lane is not in the model table",
    );
  });

  it("the shipped fixtures stay dupe-free through the new check", () => {
    for (const fixture of ["company-a", "company-b"]) {
      const raw = readFixture(fixture) as Record<string, unknown>;
      expect(() => resolveConfig(raw)).not.toThrow();
    }
  });

  it("the schema backstop refuses byte-identical rows", () => {
    const validateSchema = hostValidator();
    const dupe = model("dup-lane");
    expect(validateSchema(withModels([dupe, structuredClone(dupe)]))).toBe(false);
  });
});
