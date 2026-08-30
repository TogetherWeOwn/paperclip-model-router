import { describe, expect, it } from "vitest";

import { bareModelIdWarnings, isProviderPinnedModelId } from "../src/config/model-id.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

describe("TOG-681 §5: bare model ids are reported as a finding", () => {
  it("treats an unprefixed id as bare", () => {
    for (const id of ["gpt-4.1", "minimax-m2.5", "claude-sonnet-5", "qwen3-coder"]) {
      expect(isProviderPinnedModelId(id), id).toBe(false);
    }
  });

  it("treats a provider-pinned id as pinned", () => {
    for (const id of ["anthropic/claude-sonnet-5", "openai/gpt-4.1", "z-ai/glm-4.6"]) {
      expect(isProviderPinnedModelId(id), id).toBe(true);
    }
  });

  it("does not accept a bare id that merely contains a slash", () => {
    expect(isProviderPinnedModelId("/gpt-4.1")).toBe(false);
    expect(isProviderPinnedModelId("gpt-4.1/")).toBe(false);
  });

  it("names every bare id in one warning and stays silent on a pinned table", () => {
    const warnings = bareModelIdWarnings(["openai/gpt-4.1", "minimax-m2.5", "qwen3-coder"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("minimax-m2.5");
    expect(warnings[0]).toContain("qwen3-coder");
    expect(warnings[0]).not.toContain("openai/gpt-4.1");

    expect(bareModelIdWarnings(["openai/gpt-4.1", "anthropic/claude-sonnet-5"])).toEqual([]);
  });

  // The finding must reach the operator through the surface they actually call:
  // POST /api/plugins/:pluginId/config/test resolves to onValidateConfig.
  it("surfaces the finding through onValidateConfig without rejecting shipped config", async () => {
    const { definition } = createPlugin();

    for (const name of ["company-a", "company-b"] as const) {
      const result = await definition.onValidateConfig!(readFixture(name));
      // Bare ids are a warning, never an error: existing company config stays valid.
      expect(result.ok, name).toBe(true);
      expect((result.warnings ?? []).some((w) => w.includes("bare and unprefixed")), name).toBe(true);
    }
  });

  it("stops warning once the table is provider-pinned", async () => {
    const { definition } = createPlugin();
    const config = readFixture("company-b") as Record<string, unknown>;
    const pin = (id: string) => `openai/${id}`;
    const models = (config.models as Array<Record<string, unknown>>).map((model) => ({
      ...model,
      id: pin(String(model.id)),
    }));
    // Pinning the table means repointing everything that references an id —
    // otherwise the fallback dangles and the failure is about that, not ids.
    const routing = config.routing as Record<string, unknown>;
    const result = await definition.onValidateConfig!({
      ...config,
      models,
      routing: { ...routing, fallbackModelId: pin(String(routing.fallbackModelId)) },
    });
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("bare and unprefixed"))).toBe(false);
  });
});
