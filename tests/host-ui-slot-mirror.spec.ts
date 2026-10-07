import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

interface Candidate {
  id: string;
  capabilities: string[];
  ui: { slots: { type: string }[] };
}
interface CapabilityResult {
  allowed: boolean;
  missing: string[];
  pluginId: string;
}

// Execute the CLI's pure mirror block without loading a host or writing a
// verification receipt. Testing a second implementation would miss mirror drift.
const source = readFileSync(new URL("../scripts/verify-against-host.mjs", import.meta.url), "utf8");
const start = source.indexOf("const FEATURE_CAPABILITIES = {");
const end = source.indexOf("const validateCapabilities =", start);
if (start < 0 || end < 0) throw new Error("Cannot locate the host verifier's capability mirror");
const validate = runInNewContext(
  `${source.slice(start, end)}\nmirrorValidateManifestCapabilities;`,
) as (candidate: Candidate) => CapabilityResult;

// Derived from Paperclip's server/src/services/plugin-capability-validator.ts
// UI_SLOT_CAPABILITIES, independently of the mirror's keys. A deleted row must
// not delete its test. These are slots, not launcher placement zones.
const cases = [
  ["appShellOverlay", "ui.action.register", "ui.sidebar.register"],
  ["organizationSwitcher", "ui.sidebar.register", "ui.action.register"],
] as const;

function candidate(types: string[], capabilities: string[]): Candidate {
  return { id: "ui-slot-probe", capabilities, ui: { slots: types.map((type) => ({ type })) } };
}

describe("host UI slot capability mirror", () => {
  it.each(cases)("%s requires %s when no capabilities are declared", (type, capability) => {
    expect(validate(candidate([type], []))).toEqual({
      allowed: false, missing: [capability], pluginId: "ui-slot-probe",
    });
  });

  it.each(cases)("%s accepts its required capability %s", (type, capability) => {
    expect(validate(candidate([type], [capability]))).toMatchObject({ allowed: true, missing: [] });
  });

  it.each(cases)("%s does not accept the other slot's capability instead of %s", (type, capability, other) => {
    expect(validate(candidate([type], [other]))).toMatchObject({ allowed: false, missing: [capability] });
  });

  it("requires both capabilities when both slots are declared", () => {
    expect(validate(candidate(cases.map(([type]) => type), []))).toMatchObject({
      allowed: false, missing: ["ui.action.register", "ui.sidebar.register"],
    });
    expect(validate(candidate(cases.map(([type]) => type), cases.map(([, capability]) => capability))))
      .toMatchObject({ allowed: true, missing: [] });
  });

  it.each(cases)("%s deduplicates its missing capability %s", (type, capability) => {
    expect(validate(candidate([type, type], []))).toMatchObject({ allowed: false, missing: [capability] });
  });

  it("does not require either capability when no UI slots are declared", () => {
    expect(validate(candidate([], []))).toMatchObject({ allowed: true, missing: [] });
  });
});
