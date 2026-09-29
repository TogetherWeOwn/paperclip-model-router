/**
 * TOG-7892 (gap G7): mutation-pin the validateSecretRefShape call sites.
 *
 * The shape validator exists and onValidateConfig calls it for the upstream
 * credential and every capacity source — but nothing failed when those calls
 * were removed. Each test below feeds a credential-shaped value through the
 * REAL onValidateConfig entry point and asserts the refusal names the exact
 * config path, so commenting out any one validation call turns the suite red:
 *
 * - capacity loop: a pasted string is the sole-cause case. resolveCapacitySources
 *   coerces a non-record apiKeySecretRef to null, so a check against the
 *   RESOLVED source reads it as "absent" and stays green (reproduced: ok:true).
 *   Only the RAW check rejects it.
 * - upstream call: a value smuggled alongside a valid reference is the
 *   sole-cause case. resolveConfig keeps records verbatim and truthy, so
 *   without the shape check there is not even a "required" error.
 * - index accuracy: the bad ref at position 1 must name sources.1, pinning
 *   that EVERY source is checked, not just the first.
 */
import { describe, expect, it } from "vitest";

import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const VALID_SECRET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function baseRaw(): Record<string, unknown> {
  return structuredClone(readFixture("company-a")) as Record<string, unknown>;
}

function withSourceSecrets(secrets: unknown[]): Record<string, unknown> {
  const raw = baseRaw();
  raw.capacityRouting = {
    enabled: true,
    sources: secrets.map((apiKeySecretRef, index) => ({
      id: `capacity-${index}`,
      statusUrl: "https://capacity.example/status",
      modelIds: ["minimax-m2.5"],
      apiKeySecretRef,
      windows: [{ name: "weekly", utilizationFields: ["used7d"] }],
    })),
  };
  return raw;
}

async function validate(raw: Record<string, unknown>) {
  const { definition } = createPlugin();
  const result = await definition.onValidateConfig!(raw);
  return { ok: result.ok, errors: result.errors ?? [], warnings: result.warnings ?? [] };
}

describe("TOG-7892: secret-ref validation calls are load-bearing", () => {
  it("rejects a pasted string at capacityRouting.sources.0.apiKeySecretRef", async () => {
    const result = await validate(withSourceSecrets(["pasted-credential-not-a-reference"]));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("capacityRouting.sources.0.apiKeySecretRef");
  });

  it("names the bypassed source when the SECOND source carries the raw string", async () => {
    const result = await validate(withSourceSecrets([null, "pasted-credential-not-a-reference"]));
    expect(result.ok).toBe(false);
    const errors = result.errors.join("\n");
    expect(errors).toContain("capacityRouting.sources.1.apiKeySecretRef");
    expect(errors).not.toContain("capacityRouting.sources.0.apiKeySecretRef");
  });

  it("rejects a credential smuggled alongside a valid capacity source reference", async () => {
    const result = await validate(withSourceSecrets([
      { type: "secret_ref", secretId: VALID_SECRET_ID, value: "pasted-credential-not-a-reference" },
    ]));
    expect(result.ok).toBe(false);
    const errors = result.errors.join("\n");
    expect(errors).toContain("capacityRouting.sources.0.apiKeySecretRef");
    expect(errors).toContain("unexpected");
  });

  it("rejects a credential smuggled alongside a valid upstream reference", async () => {
    const raw = baseRaw();
    (raw.upstream as Record<string, unknown>).credentialSecretRef = {
      type: "secret_ref",
      secretId: VALID_SECRET_ID,
      value: "pasted-credential-not-a-reference",
    };
    const result = await validate(raw);
    expect(result.ok).toBe(false);
    const errors = result.errors.join("\n");
    expect(errors).toContain("upstream.credentialSecretRef");
    expect(errors).toContain("unexpected");
  });

  it("still accepts a valid reference and an absent one (no false positive)", async () => {
    const result = await validate(withSourceSecrets([
      { type: "secret_ref", secretId: VALID_SECRET_ID },
      null,
    ]));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
