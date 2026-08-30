import { describe, expect, it } from "vitest";

import { modelProfiles as claudeLocalModelProfiles } from "@paperclipai/adapter-claude-local";
import llmWikiManifest from "../../../packages/plugins/plugin-llm-wiki/src/manifest";

import { mergeModelProfileAdapterConfig, resolveModelProfileApplication } from "../services/heartbeat";

// TOG-689. TOG-685 proved the merge order; the follow-up question is narrower:
// the route-layer `cheap: { enabled: false }` guard is keyed on the key being
// ABSENT, so it never sanitizes a `cheap` profile a caller supplies explicitly.
// These tests answer whether any provisioning declaration actually supplies one,
// and what the resolver does with the shape it supplies.
const cheapAdapterProfile = claudeLocalModelProfiles.find((p) => p.key === "cheap")!;

function resolveCheap(storedCheapProfile: unknown) {
  const modelProfile = resolveModelProfileApplication({
    adapterModelProfiles: [cheapAdapterProfile],
    agentRuntimeConfig: { modelProfiles: { cheap: storedCheapProfile } },
    issueModelProfile: null,
    contextSnapshot: { modelProfile: "cheap" },
  });
  return {
    modelProfile,
    merged: mergeModelProfileAdapterConfig({
      baseConfig: { model: "claude-opus-5" },
      modelProfile,
      issueAdapterConfig: null,
    }),
  };
}

describe("TOG-689: an explicitly-supplied cheap profile is born armed", () => {
  it("a cheap profile with no `enabled` key resolves as ENABLED", () => {
    // readAgentRuntimeModelProfile (heartbeat.ts:3460) reads `enabled !== false`,
    // so omitting `enabled` is opt-IN, not opt-out. This is the shape a
    // provisioning declaration most naturally writes.
    const { modelProfile } = resolveCheap({ purpose: "classification" });
    expect(modelProfile.fallbackReason).toBeNull();
    expect(modelProfile.applied).toBe("cheap");
  });

  it("ARMED: an explicit cheap profile without a falsy effort takes effort:low", () => {
    const { merged } = resolveCheap({ purpose: "classification" });
    expect(merged.effort).toBe("low");
  });

  it("pinning effort:\"\" on that same shape disarms it", () => {
    const { merged } = resolveCheap({
      purpose: "classification",
      adapterConfig: { effort: "" },
    });
    expect(merged.effort).toBe("");
  });
});

describe("TOG-689: which shipped declaration supplies an explicit cheap profile", () => {
  // The audit result: exactly one declaration in the tree does, and it is a
  // plugin manifest, not a built-in agent and not the org provisioner.
  const wikiAgent = llmWikiManifest.agents?.find(
    (agent: { adapterType?: string }) => agent.adapterType === "claude_local",
  ) as { runtimeConfig?: { modelProfiles?: { cheap?: Record<string, unknown> } } } | undefined;

  it("plugin-llm-wiki declares runtimeConfig.modelProfiles.cheap", () => {
    expect(wikiAgent?.runtimeConfig?.modelProfiles?.cheap).toBeDefined();
  });

  it("and that declaration is the armed shape: no `enabled`, no `effort`", () => {
    const cheap = wikiAgent!.runtimeConfig!.modelProfiles!.cheap!;
    expect(cheap).not.toHaveProperty("enabled");
    expect((cheap.adapterConfig as Record<string, unknown> | undefined)?.effort).toBeUndefined();

    // Fed through the live resolver, it reaches ACP with the fatal key.
    expect(resolveCheap(cheap).merged.effort).toBe("low");
  });
});
