import { describe, expect, it } from "vitest";

import { modelProfiles as claudeLocalModelProfiles } from "@paperclipai/adapter-claude-local";

import { mergeModelProfileAdapterConfig, resolveModelProfileApplication } from "../services/heartbeat";

// TOG-685. The claim under test: stripping `effort` from an agent's stored
// cheap profile stops `effort` from reaching the ACP lane. It does not --
// resolveModelProfileApplication spreads the ADAPTER DEFAULT FIRST, so any key
// the stored profile does not explicitly set is re-supplied by the adapter.
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

describe("TOG-685: the real claude_local cheap profile", () => {
  it("ships effort:low as an adapter default", () => {
    expect(cheapAdapterProfile.adapterConfig).toMatchObject({ effort: "low" });
  });

  it("REGRESSION: deleting effort from the stored profile does NOT remove it", () => {
    // This is exactly what the fleet-wide sweep wrote.
    const { merged } = resolveCheap({
      enabled: true,
      adapterConfig: { model: "cliproxy/claude-haiku-4-5-20251001" },
    });
    // The adapter default spreads back in. The sweep is cosmetic on this lane.
    expect(merged.effort).toBe("low");
  });

  it("explicitly blanking effort DOES suppress it", () => {
    const { merged } = resolveCheap({
      enabled: true,
      adapterConfig: { model: "cliproxy/claude-haiku-4-5-20251001", effort: "" },
    });
    expect(merged.effort).toBe("");
  });

  it("disabling the cheap profile drops the adapter config entirely", () => {
    const { modelProfile, merged } = resolveCheap({ enabled: false });
    expect(modelProfile.fallbackReason).toBe("agent_runtime_profile_disabled");
    expect(modelProfile.adapterConfig).toBeNull();
    expect(merged).not.toHaveProperty("effort");
  });
});
