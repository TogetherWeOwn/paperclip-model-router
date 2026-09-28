/**
 * G17 (TOG-7846 rev 2): the README's full company-config example drifts
 * silently — `docs-install-version.spec` only checks the version string, so a
 * renamed key, a dropped section, or a stray field in the example stays green
 * while every operator who copy-pastes it gets a config the host rejects (or,
 * worse, one the resolver silently trims).
 *
 * This spec parses the example out of README.md and runs it through the same
 * two gates a real company config meets: the host's Ajv-compiled
 * `ROUTER_CONFIG_SCHEMA` (strict: `additionalProperties: false` at every
 * level) and the runtime `resolveConfig` + `validateUpstreamConfig` path.
 *
 * Acceptance shape: a reviewer adding a bogus field to the README example
 * must turn CI red with a message naming README.md. The strictness cases
 * below prove that property by construction — each one is the README example
 * plus exactly one bogus field, and each must fail schema validation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import { validateSecretRefShape } from "../src/config/secret-ref.js";
import { validateUpstreamConfig } from "../src/inference/adapters.js";

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

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SECTION = "## Company configuration";

/**
 * The single source of truth for "the README config example": the first
 * fenced ```json block under `## Company configuration`. Anything else in
 * README.md (the invocation payload further down is also ```json) must not
 * be mistaken for it — the `upstream` key check below guards the match.
 */
function readReadmeConfigExample(): Record<string, unknown> {
  const source = readFileSync(join(repo, "README.md"), "utf8");
  const sectionStart = source.indexOf(CONFIG_SECTION);
  if (sectionStart < 0) {
    throw new Error(
      `README.md must keep a '${CONFIG_SECTION}' section carrying the full company config example.`,
    );
  }
  const match = source.slice(sectionStart).match(/```json[ \t]*\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(
      `README.md '${CONFIG_SECTION}' must contain a fenced \`\`\`json company config example.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(
      `README.md company config example is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("upstream" in parsed)) {
    throw new Error(
      "README.md company config example must be a JSON object with an 'upstream' key. " +
        `The first \`\`\`json fence under '${CONFIG_SECTION}' was matched instead — the example may have moved.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object while cloning the README.md config example");
  }
  return value as Record<string, unknown>;
}

describe("README company config example", () => {
  it("validates against ROUTER_CONFIG_SCHEMA", () => {
    const example = readReadmeConfigExample();
    const validate = hostValidator();
    expect(
      validate(example),
      `README.md company config example fails ROUTER_CONFIG_SCHEMA: ${JSON.stringify(validate.errors)}. ` +
        `Update the example in README.md '${CONFIG_SECTION}' to match the schema.`,
    ).toBe(true);
  });

  it("resolves through the runtime path with no upstream or credential errors", () => {
    const example = readReadmeConfigExample();
    const config = resolveConfig(example);
    // The resolver must preserve the example's model table entry-for-entry:
    // a silently dropped model is the same drift this spec exists to catch.
    const rawIds = (asRecord(example).models as Array<Record<string, unknown>>).map((model) => model.id);
    expect(config.models.map((model) => model.id)).toEqual(rawIds);
    expect(
      validateUpstreamConfig(config.upstream),
      "README.md company config example fails the runtime upstream validator. " +
        "Update the example in README.md to use values the runtime accepts.",
    ).toEqual([]);
    expect(
      validateSecretRefShape(
        asRecord(asRecord(example).upstream).credentialSecretRef,
        "README.md upstream.credentialSecretRef",
      ),
      "README.md company config example carries an invalid credentialSecretRef shape.",
    ).toBeNull();
  });

  it("rejects one bogus field at every level (unknown-field strictness)", () => {
    const cases: Array<{ label: string; mutate: (clone: Record<string, unknown>) => void; field: string }> = [
      { label: "top level", field: "bogusReadmeField", mutate: (clone) => { clone.bogusReadmeField = true; } },
      { label: "routing", field: "bogus", mutate: (clone) => { asRecord(clone.routing).bogus = 1; } },
      { label: "upstream", field: "bogus", mutate: (clone) => { asRecord(clone.upstream).bogus = 1; } },
      {
        label: "models[0]",
        field: "bogus",
        mutate: (clone) => { asRecord((clone.models as Array<unknown>)[0]).bogus = 1; },
      },
      {
        label: "taskClasses[0]",
        field: "bogus",
        mutate: (clone) => { asRecord((clone.taskClasses as Array<unknown>)[0]).bogus = 1; },
      },
      { label: "tiering", field: "bogus", mutate: (clone) => { asRecord(clone.tiering).bogus = 1; } },
      { label: "budget", field: "bogus", mutate: (clone) => { asRecord(clone.budget).bogus = 1; } },
      {
        label: "capacityRouting",
        field: "bogus",
        mutate: (clone) => { asRecord(clone.capacityRouting).bogus = 1; },
      },
      { label: "rule0", field: "bogus", mutate: (clone) => { asRecord(clone.rule0).bogus = 1; } },
    ];
    for (const { label, mutate, field } of cases) {
      const clone = structuredClone(readReadmeConfigExample());
      mutate(clone);
      const validate = hostValidator();
      expect(
        validate(clone),
        `ROUTER_CONFIG_SCHEMA must reject an unknown '${field}' field at ${label}: ` +
          `a bogus README.md field there would otherwise drift silently.`,
      ).toBe(false);
      // The failure must name the field, so a reviewer adding one to README.md
      // gets CI output pointing at what to remove.
      const errors = JSON.stringify(validate.errors ?? null);
      expect(
        errors,
        `schema rejection of unknown '${field}' at ${label} must name the field in its errors.`,
      ).toContain(field);
    }
  });
});
