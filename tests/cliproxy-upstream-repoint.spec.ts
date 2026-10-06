import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/cliproxy-upstream-repoint.mjs");

const RETIRED = "https://router.infextion.net";
const HEALTHY = "https://cliproxy.infextion.net";
const OLD_SECRET = "11111111-1111-4111-8111-111111111111";
const NEW_SECRET = "22222222-2222-4222-8222-222222222222";

interface TestBackupUpstream {
  protocol: string;
  baseUrl: string;
  credentialSecretRef: { type: string; secretId: string };
  requestTimeoutMs: number;
  maxResponseBytes: number;
  extraHeaders: Record<string, string>;
}

interface TestBackup {
  companyId: string;
  configJson: {
    upstream?: TestBackupUpstream;
    models: Array<Record<string, unknown>>;
    taskClasses: unknown[];
    [key: string]: unknown;
  };
}

/**
 * Literal synthetic backup shaped like `plugin config --json` output. The ids
 * and urls are fixtures, not live values -- this spec pins the transformer's
 * guards, never a real config. model ids use the same `cliproxy/` prefix shape
 * the probe observed so the payload-preservation assertion covers them.
 */
function backupWith(overrides: Record<string, unknown> = {}): TestBackup {
  return {
    companyId: "00000000-0000-4000-8000-000000000000",
    configJson: {
      upstream: {
        protocol: "openai-chat-completions",
        baseUrl: RETIRED,
        credentialSecretRef: { type: "secret_ref", secretId: OLD_SECRET },
        requestTimeoutMs: 25000,
        maxResponseBytes: 8388608,
        extraHeaders: {},
      },
      models: [
        {
          id: "cliproxy/gpt-6-luna",
          tier: "frontier",
          quality: 90,
          costPerMTokIn: 1,
          costPerMTokOut: 5,
          contextWindow: 200000,
          capabilities: ["tools"],
          enabled: true,
        },
        {
          id: "cliproxy/grok-build-0.1",
          tier: "standard",
          quality: 70,
          costPerMTokIn: 1,
          costPerMTokOut: 5,
          contextWindow: 128000,
          capabilities: ["tools"],
          enabled: true,
        },
      ],
      taskClasses: [{ key: "implementation", qualityFloor: 70 }],
      ...overrides,
    },
  };
}

function runTransform(input: TestBackup, extraArgs: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-"));
  const inputFile = path.join(dir, "backup.json");
  const outputFile = path.join(dir, "payload.json");
  fs.writeFileSync(inputFile, JSON.stringify(input));
  try {
    execFileSync("node", [SCRIPT, "--input", inputFile, "--output", outputFile, ...extraArgs], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    return { ok: true as const, payload: JSON.parse(fs.readFileSync(outputFile, "utf8")) };
  } catch (error) {
    return { ok: false as const, stderr: String(error instanceof Error ? error.message : error) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const secretArgs = ["--credential-secret-id", NEW_SECRET];

describe("cliproxy-upstream-repoint", () => {
  it("repoints baseUrl + secret ref and leaves everything else identical", () => {
    const input = backupWith();
    const result = runTransform(input, secretArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.payload.configJson;
    expect(config.upstream.baseUrl).toBe(HEALTHY);
    expect(config.upstream.protocol).toBe("openai-chat-completions");
    expect(config.upstream.credentialSecretRef).toEqual({ type: "secret_ref", secretId: NEW_SECRET });
    // The verbatim model roster (including cliproxy/-prefixed ids) must pass
    // through untouched: renaming is a separate, evidence-gated decision.
    expect(config.models).toEqual(input.configJson.models);
    expect(config.taskClasses).toEqual(input.configJson.taskClasses);
    expect(config.upstream.requestTimeoutMs).toBe(25000);
    expect(config.upstream.extraHeaders).toEqual({});
  });

  it("refuses a backup that is already re-pointed (no double-apply)", () => {
    const input = backupWith();
    const upstream = input.configJson.upstream;
    if (!upstream) throw new Error("fixture must include an upstream block");
    upstream.baseUrl = HEALTHY;
    const result = runTransform(input, secretArgs);
    expect(result.ok).toBe(false);
  });

  it("refuses a backup pointing at an unexpected third endpoint", () => {
    const input = backupWith();
    const upstream = input.configJson.upstream;
    if (!upstream) throw new Error("fixture must include an upstream block");
    upstream.baseUrl = "https://third.example";
    const result = runTransform(input, secretArgs);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-UUID replacement secret id", () => {
    const result = runTransform(backupWith(), ["--credential-secret-id", "not-a-uuid"]);
    expect(result.ok).toBe(false);
  });

  it("refuses when the replacement equals the current secret id", () => {
    const result = runTransform(backupWith(), ["--credential-secret-id", OLD_SECRET]);
    expect(result.ok).toBe(false);
  });

  it("applies declared remaps and leaves every other model identical", () => {
    const input = backupWith();
    const result = runTransform(input, [
      ...secretArgs,
      "--remap", "cliproxy/gpt-6-luna=openai/gpt-6-luna",
      "--remap", "cliproxy/grok-build-0.1=grok-build-0.1",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.payload.configJson.models.map((model: Record<string, unknown>) => model.id);
    expect(ids).toEqual(["openai/gpt-6-luna", "grok-build-0.1"]);
    // Non-id fields of remapped entries survive the rename.
    expect(result.payload.configJson.models[0].tier).toBe("frontier");
    expect(result.payload.configJson.models[1].contextWindow).toBe(128000);
    expect(result.payload.configJson.models).toHaveLength(input.configJson.models.length);
  });

  it("refuses a remap whose source id is absent from the roster", () => {
    const result = runTransform(backupWith(), [...secretArgs, "--remap", "cliproxy/nope=model"]);
    expect(result.ok).toBe(false);
  });

  it("refuses a no-op remap and a remap onto an existing id", () => {
    const input = backupWith();
    const sameId = input.configJson.models[0]?.id;
    if (typeof sameId !== "string") throw new Error("fixture must include a string model id");
    expect(runTransform(backupWith(), [...secretArgs, "--remap", `${sameId}=${sameId}`]).ok).toBe(false);
    const otherId = input.configJson.models[1]?.id;
    if (typeof otherId !== "string") throw new Error("fixture must include a string model id");
    expect(runTransform(backupWith(), [...secretArgs, "--remap", `${sameId}=${otherId}`]).ok).toBe(false);
  });

  it("reads bulk actions from --flags-file in the runbook's literal argv shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flags-"));
    try {
      const flagsFile = path.join(dir, "flags.txt");
      fs.writeFileSync(flagsFile, "--remap cliproxy/gpt-6-luna=openai/gpt-6-luna\n--disable cliproxy/gpt-5.4\n");
      const inputFile = path.join(dir, "backup.json");
      const outputFile = path.join(dir, "payload.json");
      const input = backupWith();
      input.configJson.models.push({
        id: "cliproxy/gpt-5.4",
        tier: "standard",
        quality: 60,
        costPerMTokIn: 1,
        costPerMTokOut: 5,
        contextWindow: 128000,
        capabilities: ["tools"],
        enabled: true,
      });
      fs.writeFileSync(inputFile, JSON.stringify(input));
      execFileSync("node", [SCRIPT, "--input", inputFile, "--output", outputFile,
        "--credential-secret-id", NEW_SECRET, "--flags-file", flagsFile],
        { stdio: ["ignore", "ignore", "pipe"] });
      const payload = JSON.parse(fs.readFileSync(outputFile, "utf8")).configJson;
      const byId = new Map(payload.models.map((model: Record<string, unknown>) => [model.id, model]));
      const first = input.configJson.models[0];
      if (!first) throw new Error("fixture must include a model");
      expect(byId.get("openai/gpt-6-luna")).toEqual({ ...first, id: "openai/gpt-6-luna" });
      expect(byId.get("cliproxy/gpt-5.4")).toMatchObject({ id: "cliproxy/gpt-5.4", enabled: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a flags file with a malformed line or a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flags-bad-"));
    try {
      const badFile = path.join(dir, "bad.txt");
      fs.writeFileSync(badFile, "--remap cliproxy/gpt-6-luna=openai/gpt-6-luna extra-token\n");
      const inputFile = path.join(dir, "backup.json");
      const outputFile = path.join(dir, "payload.json");
      fs.writeFileSync(inputFile, JSON.stringify(backupWith()));
      const run = (args: string[]) => {
        try {
          execFileSync("node", [SCRIPT, "--input", inputFile, "--output", outputFile, ...args],
            { stdio: ["ignore", "ignore", "pipe"] });
          return true;
        } catch {
          return false;
        }
      };
      expect(run(["--credential-secret-id", NEW_SECRET, "--flags-file", badFile])).toBe(false);
      expect(run(["--credential-secret-id", NEW_SECRET, "--flags-file", path.join(dir, "absent.txt")])).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a backup with no upstream block instead of inventing one", () => {
    const input = backupWith();
    delete input.configJson.upstream;
    const result = runTransform(input, secretArgs);
    expect(result.ok).toBe(false);
  });
});
