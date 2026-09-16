import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readFixture } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/tog-2922-config-delta.mjs");
const sourceIds = ["cliproxy-claude", "cliproxy-codex", "cliproxy-kimi", "cliproxy-opencode-go"];

function liveConfig() {
  const config = readFixture("company-a") as Record<string, unknown>;
  config.capacityRouting = {
    enabled: true,
    mode: "enforce",
    unknownTelemetry: "fail-open",
    sources: sourceIds.map((id, index) => ({
      id,
      statusUrl: `https://router.example/${id}.json`,
      apiKeySecretRef: { type: "secret_ref", secretId: `${index + 1}1111111-1111-4111-8111-111111111111`.slice(0, 36) },
      modelIds: [index === 0 ? "claude-sonnet-5" : "minimax-m2.5"],
      healthFields: ["health"],
      requestTimeoutMs: 5000,
      maxResponseBytes: 262144,
      windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
    })),
  };
  return config;
}

function run(command: "prepare" | "enable" | "restore", input: string, output: string) {
  execFileSync(process.execPath, [script, command, "--input", input, "--output", output], { stdio: "pipe" });
  return JSON.parse(fs.readFileSync(output, "utf8"));
}

describe("TOG-2922 deterministic config delta", () => {
  it("preserves the roster and secret refs, then makes the enable exactly one key", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tog-2922-config-"));
    try {
      const input = path.join(directory, "before.json");
      const prerequisite = path.join(directory, "prerequisite.json");
      const enabled = path.join(directory, "enabled.json");
      const before = liveConfig();
      fs.writeFileSync(input, JSON.stringify({ configJson: before }));

      const prepared = run("prepare", input, prerequisite).configJson;
      expect(prepared.models).toEqual(before.models);
      expect(prepared.upstream).toEqual(before.upstream);
      expect(prepared.capacityRouting.paceOrdering).toBe(false);
      expect(prepared.capacityRouting.sources.map((source: Record<string, unknown>) => source.id)).toEqual(sourceIds);
      expect(prepared.capacityRouting.sources.every((source: Record<string, unknown>) => source.pace)).toBe(true);
      expect(prepared.capacityRouting.sources[2].pace.windows).toEqual([]);
      expect(prepared.capacityRouting.sources.map((source: Record<string, unknown>) => source.apiKeySecretRef))
        .toEqual((before.capacityRouting as { sources: Array<Record<string, unknown>> }).sources.map((source) => source.apiKeySecretRef));

      const oneKey = run("enable", prerequisite, enabled).configJson;
      const expected = structuredClone(prepared);
      expected.capacityRouting.paceOrdering = true;
      expect(oneKey).toEqual(expected);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an incomplete live source set", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tog-2922-config-"));
    try {
      const input = path.join(directory, "before.json");
      const output = path.join(directory, "after.json");
      const config = liveConfig();
      (config.capacityRouting as { sources: unknown[] }).sources.pop();
      fs.writeFileSync(input, JSON.stringify({ configJson: config }));
      expect(() => execFileSync(process.execPath, [script, "prepare", "--input", input, "--output", output], { stdio: "pipe" }))
        .toThrow();
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
