/**
 * TOG-14777 (O1 leaf of the TOG-14764 fan-out, sliced from TOG-13513):
 * pacing-lane entry shape, defaults and resolver behavior for the
 * meta/Claude/Codex lanes — fixtures only.
 *
 * In this repo a "pacing lane" is a `capacityRouting.sources[]` row carrying a
 * `pace` block (`SourcePaceDefinition`, resolved by `resolveSourcePace` in
 * `src/config/resolve.ts` against `ROUTER_CONFIG_SCHEMA` in
 * `src/config/schema.ts`). The three lane rows mirror the lane-row vector
 * suites so schema/resolver pins and consumer vectors agree on lane identity:
 * cliproxy-meta binds muse-spark-1.3-contributor (muse fixture), cliproxy-claude
 * binds oc/claude-sonnet-5 and cliproxy-codex binds oc/gpt-5.6-codex (pack-2).
 *
 * Every case runs offline through the compiled schema or `resolveConfig` — no
 * HTTP, no live catalogue read, no roster write. Live lanes wiring and roster
 * apply belong to TOG-13934 and are non-goals here, as are the bridge-model gap
 * tests (TOG-13976) and the agreement harness (TOG-14134).
 *
 * The fixture lives beside this spec, not in tests/fixtures/: the host gate
 * validates every JSON file directly under tests/fixtures/ against the
 * instance config schema, which a synthetic vectors table can never satisfy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";

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

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "pacing-lanes-meta-claude-codex.fixture.json"), "utf8"),
) as {
  version: number;
  description: string;
  sources: Record<string, Record<string, unknown>>;
  edges: Record<string, Record<string, unknown>>;
};

const UPSTREAM = {
  protocol: "openai-chat-completions",
  baseUrl: "https://compatible.example.invalid",
  credentialSecretRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
};

function asFullConfig(source: Record<string, unknown>): Record<string, unknown> {
  return { upstream: UPSTREAM, capacityRouting: { sources: [source] } };
}

function resolveSources(raw: unknown[]): CapacitySourceConfig[] {
  return resolveConfig({ upstream: UPSTREAM, capacityRouting: { sources: raw } }).capacityRouting.sources;
}

function resolveOne(raw: Record<string, unknown>): CapacitySourceConfig {
  const [only] = resolveSources([raw]);
  if (!only) throw new Error("resolver dropped the only source");
  return only;
}

describe("pacing-lane entry schema (meta/Claude/Codex)", () => {
  it.each(["meta", "claude", "codex"])("accepts the %s lane row", (lane) => {
    const validate = hostValidator();
    expect(validate(asFullConfig(fixture.sources[lane]!)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a minimal pace row carrying only laneId", () => {
    const validate = hostValidator();
    expect(validate(asFullConfig(fixture.sources["minimalPace"]!)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a health-only pace row (empty windows) and a source without pace", () => {
    const validate = hostValidator();
    expect(validate(asFullConfig(fixture.edges["healthOnlyPace"]!)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(asFullConfig(fixture.edges["noPace"]!)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a pace block without laneId", () => {
    const validate = hostValidator();
    expect(validate(asFullConfig(fixture.edges["missingLaneId"]!))).toBe(false);
  });

  it("rejects a pace window with an unknown role", () => {
    const validate = hostValidator();
    const badRole = {
      ...fixture.edges["mixedWindows"]!,
      pace: {
        laneId: "cliproxy-bad-role",
        windows: [{ name: "weekly", role: "throttle", utilizationFields: ["weekly_utilization"] }],
      },
    };
    expect(validate(asFullConfig(badRole))).toBe(false);
  });

  it("rejects a pace window with empty utilizationFields", () => {
    const validate = hostValidator();
    const emptyUtil = {
      ...fixture.edges["mixedWindows"]!,
      pace: {
        laneId: "cliproxy-empty-util",
        windows: [{ name: "weekly", role: "allowance", utilizationFields: [] }],
      },
    };
    expect(validate(asFullConfig(emptyUtil))).toBe(false);
  });

  it("rejects an unknown pace key", () => {
    const validate = hostValidator();
    const extraKey = {
      ...fixture.sources["meta"]!,
      pace: { ...(fixture.sources["meta"]!["pace"] as Record<string, unknown>), provider: "cliproxy" },
    };
    expect(validate(asFullConfig(extraKey))).toBe(false);
  });

  it("rejects a source with empty legacy windows (schema is strict; the resolver is not)", () => {
    // Paired with the resolver test below: the host schema demands at least
    // one legacy capacity window per source, while resolveConfig maps whatever
    // windows exist. A row that is valid JSON but schema-invalid must never be
    // mistaken for a row the host would accept.
    const validate = hostValidator();
    expect(validate(asFullConfig(fixture.edges["emptyLegacyWindows"]!))).toBe(false);
  });
});

describe("pacing-lane resolver (meta/Claude/Codex)", () => {
  it.each([
    ["meta", "cliproxy-meta", ["muse-spark-1.3-contributor"]],
    ["claude", "cliproxy-claude", ["oc/claude-sonnet-5"]],
    ["codex", "cliproxy-codex", ["oc/gpt-5.6-codex"]],
  ])("preserves the %s laneId and model binding", (lane, laneId, modelIds) => {
    const resolved = resolveOne(fixture.sources[lane]!);
    expect(resolved.id).toBe(laneId);
    expect(resolved.modelIds).toEqual(modelIds);
    expect(resolved.pace?.laneId).toBe(laneId);
  });

  it("defaults pace healthFields to [health] when the row omits them", () => {
    const resolved = resolveOne(fixture.sources["minimalPace"]!);
    expect(resolved.pace?.laneId).toBe("cliproxy-minimal");
    expect(resolved.pace?.healthFields).toEqual(["health"]);
    expect(resolved.pace?.windows).toEqual([]);
  });

  it("keeps the explicit pace healthFields on all three lanes", () => {
    for (const lane of ["meta", "claude", "codex"]) {
      expect(resolveOne(fixture.sources[lane]!).pace?.healthFields).toEqual(["state"]);
    }
  });

  it("marks free only when the row says so explicitly", () => {
    expect(resolveOne(fixture.sources["codex"]!).pace?.free).toBe(true);
    expect(resolveOne(fixture.sources["meta"]!).pace?.free).toBeUndefined();
    expect(resolveOne(fixture.sources["claude"]!).pace?.free).toBeUndefined();
  });

  it("preserves the codex field overrides and leaves them absent elsewhere", () => {
    const codex = resolveOne(fixture.sources["codex"]!).pace!;
    expect(codex.weightFields).toEqual(["weight"]);
    expect(codex.governingWindowField).toBe("governing_window");
    expect(codex.windowSecondsField).toBe("window_seconds");
    expect(codex.staleAfterSecondsField).toBe("staleAfterSeconds");
    const meta = resolveOne(fixture.sources["meta"]!).pace!;
    expect(meta.weightFields).toBeUndefined();
    expect(meta.governingWindowField).toBeUndefined();
    expect(meta.windowSecondsField).toBeUndefined();
    expect(meta.staleAfterSecondsField).toBeUndefined();
  });

  it("preserves pace windows including resetFields and defaultWindowSeconds", () => {
    const windows = resolveOne(fixture.sources["codex"]!).pace!.windows;
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      name: "five-hour",
      role: "serviceability",
      utilizationFields: ["five_hour_utilization"],
      resetFields: ["five_hour_resets_at"],
      defaultWindowSeconds: 18000,
    });
    expect(windows[1]).toMatchObject({
      name: "weekly",
      role: "allowance",
      utilizationFields: ["weekly_utilization"],
    });
  });

  it("drops malformed pace windows and keeps the one good row", () => {
    const windows = resolveOne(fixture.edges["mixedWindows"]!).pace!.windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.name).toBe("five-hour");
  });

  it("resolves a pace block without laneId to undefined instead of throwing", () => {
    expect(() => resolveSources([fixture.edges["missingLaneId"]!])).not.toThrow();
    expect(resolveOne(fixture.edges["missingLaneId"]!).pace).toBeUndefined();
  });

  it("resolves a health-only pace row to a defined pace with empty windows", () => {
    // Explicit unknown: the lane stays pace-neutral (never denied) until
    // utilization telemetry appears, per the SourcePaceDefinition contract.
    const pace = resolveOne(fixture.edges["healthOnlyPace"]!).pace;
    expect(pace?.laneId).toBe("cliproxy-health-only");
    expect(pace?.windows).toEqual([]);
  });

  it("resolves a source without pace to undefined (fail-neutral, like missing telemetry)", () => {
    expect(resolveOne(fixture.edges["noPace"]!).pace).toBeUndefined();
  });

  it("keeps a source with empty legacy windows (resolver-lenient, schema-strict)", () => {
    const resolved = resolveOne(fixture.edges["emptyLegacyWindows"]!);
    expect(resolved.windows).toEqual([]);
    expect(resolved.pace?.laneId).toBe("cliproxy-empty-legacy");
  });

  it("drops sources missing id or statusUrl without throwing", () => {
    expect(() =>
      resolveSources([
        { statusUrl: "https://telemetry.example.invalid/no-id", modelIds: ["x"], windows: [] },
        { id: "cliproxy-no-url", modelIds: ["x"], windows: [] },
      ]),
    ).not.toThrow();
    expect(
      resolveSources([
        { statusUrl: "https://telemetry.example.invalid/no-id", modelIds: ["x"], windows: [] },
        { id: "cliproxy-no-url", modelIds: ["x"], windows: [] },
      ]),
    ).toEqual([]);
  });
});
