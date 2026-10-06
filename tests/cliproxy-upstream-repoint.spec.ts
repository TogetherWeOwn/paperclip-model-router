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

  it("merge keeps the enabled twin's full record and darkens the loser", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
    try {
      const inputFile = path.join(dir, "backup.json");
      const outputFile = path.join(dir, "payload.json");
      const input = backupWith();
      input.configJson.models = [
        { id: "opencode-go/glm-5.3", tier: "standard", quality: 70, costPerMTokIn: 1, costPerMTokOut: 5, contextWindow: 128000, capabilities: ["tools"], enabled: false },
        { id: "cliproxy/glm-5.3", tier: "frontier", quality: 90, costPerMTokIn: 2, costPerMTokOut: 8, contextWindow: 200000, capabilities: ["tools", "vision"], enabled: true },
      ];
      fs.writeFileSync(inputFile, JSON.stringify(input));
      execFileSync("node", [SCRIPT, "--input", inputFile, "--output", outputFile,
        "--credential-secret-id", NEW_SECRET,
        "--merge", "glm-5.3 opencode-go/glm-5.3 cliproxy/glm-5.3"],
        { stdio: ["ignore", "ignore", "pipe"] });
      const models = JSON.parse(fs.readFileSync(outputFile, "utf8")).configJson.models as Array<Record<string, unknown>>;
      expect(models).toHaveLength(2);
      const byId = new Map(models.map((model) => [model.id as string, model]));
      // Survivor is the enabled cliproxy record, renamed; the disabled twin is dark.
      expect(byId.get("glm-5.3")).toEqual({
        id: "glm-5.3", tier: "frontier", quality: 90, costPerMTokIn: 2,
        costPerMTokOut: 8, contextWindow: 200000, capabilities: ["tools", "vision"], enabled: true,
      });
      expect(byId.get("opencode-go/glm-5.3")).toMatchObject({ enabled: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge refuses both-enabled twins and unknown ids", () => {
    const input = backupWith();
    input.configJson.models = [
      { id: "a", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [], enabled: true },
      { id: "b", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [], enabled: true },
    ];
    expect(runTransform(input, [...secretArgs, "--merge", "c a b"]).ok).toBe(false);
    expect(runTransform(backupWith(), [...secretArgs, "--merge", "c nope cliproxy/gpt-6-luna"]).ok).toBe(false);
    expect(runTransform(backupWith(), [...secretArgs, "--merge", "cliproxy/gpt-6-luna cliproxy/gpt-6-luna cliproxy/grok-build-0.1"]).ok).toBe(false);
  });

  it("merge treats a missing enabled key as live (runtime default-enabled)", () => {
    // Regression for the Paperclip Review 3/5: the transformer used
    // `enabled === true`, so a keyless twin was silently disabled and the
    // both-live guard never fired. Runtime treats a missing key as enabled
    // (src/config/resolve.ts:146 pickBoolean(raw.enabled, true)).
    const input = backupWith();
    input.configJson.models = [
      { id: "opencode-go/glm-5.3", tier: "standard", quality: 70, costPerMTokIn: 1, costPerMTokOut: 5, contextWindow: 128000, capabilities: ["tools"], enabled: false },
      { id: "cliproxy/glm-5.3", tier: "frontier", quality: 90, costPerMTokIn: 2, costPerMTokOut: 8, contextWindow: 200000, capabilities: ["tools", "vision"] },
    ];
    delete (input.configJson.models[1] as Record<string, unknown>).enabled;
    const result = runTransform(input, [...secretArgs, "--merge", "glm-5.3 opencode-go/glm-5.3 cliproxy/glm-5.3"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const models = result.payload.configJson.models as Array<Record<string, unknown>>;
    const byId = new Map(models.map((model) => [model.id as string, model]));
    // Keyless winner keeps its entire record (still keyless, still live).
    const survivor = byId.get("glm-5.3");
    expect(survivor).toMatchObject({ id: "glm-5.3", tier: "frontier", quality: 90 });
    expect(survivor).not.toHaveProperty("enabled", false);
    expect((survivor as Record<string, unknown>).enabled !== false).toBe(true);
    expect(byId.get("opencode-go/glm-5.3")).toMatchObject({ enabled: false });
  });

  it("merge refuses both-live twins when either side is default-enabled", () => {
    // Both-live ambiguity must fail closed: keyless+true and keyless+keyless
    // are both live pairs, not a winner plus a dark loser.
    const keylessTrue = backupWith();
    keylessTrue.configJson.models = [
      { id: "a", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [] },
      { id: "b", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [], enabled: true },
    ];
    expect(runTransform(keylessTrue, [...secretArgs, "--merge", "c a b"]).ok).toBe(false);
    const keylessKeyless = backupWith();
    keylessKeyless.configJson.models = [
      { id: "a", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [] },
      { id: "b", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [] },
    ];
    expect(runTransform(keylessKeyless, [...secretArgs, "--merge", "c a b"]).ok).toBe(false);
  });

  it("merge accepts three separate argv tokens as well as the quoted triple", () => {
    // Documents the direct-argv advisory: --merge target srcA srcB (unquoted)
    // parses to the same triple as --merge "target srcA srcB".
    const modelsFor = (): TestBackup => {
      const input = backupWith();
      input.configJson.models = [
        { id: "a", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 1, capabilities: [], enabled: false },
        { id: "b", tier: "standard", quality: 1, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 9, capabilities: [], enabled: true },
      ];
      return input;
    };
    const quoted = runTransform(modelsFor(), [...secretArgs, "--merge", "c a b"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-argv-"));
    try {
      const inputFile = path.join(dir, "backup.json");
      const outputFile = path.join(dir, "payload.json");
      fs.writeFileSync(inputFile, JSON.stringify(modelsFor()));
      // Separate argv tokens: no shell quoting involved (execFile arg list).
      execFileSync("node", [SCRIPT, "--input", inputFile, "--output", outputFile,
        "--credential-secret-id", NEW_SECRET, "--merge", "c", "a", "b"],
        { stdio: ["ignore", "ignore", "pipe"] });
      const direct = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) return;
      expect(direct.configJson.models).toEqual(quoted.payload.configJson.models);
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
