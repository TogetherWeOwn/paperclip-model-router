import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/cliproxy-upstream-repoint.mjs");
const DECIDED_FLAGS = path.join(ROOT, "docs/operator/cliproxy-roster-decided.txt");
const PENDING_FLAGS = path.join(ROOT, "docs/operator/cliproxy-roster-pending.txt");

/**
 * Full-roster reconciliation against the host preflight evidence (113
 * configured ids, live catalogue HTTP 200 / 181 served, 11 verbatim hits).
 * These literals are transcribed from the evidence table and are the
 * independent witness over the operator flag files: a typo in either file
 * turns this suite red. Ids here are public catalogue-adjacent strings and
 * synthetic fixtures -- no live config, no credentials.
 *
 * Mapping rule applied per miss: vendor-namespace candidate first
 * (openai/, claude/, meta/ -- canonical identity, matches the one deployed
 * static-alias precedent), else the bare suffix (direct-path precedent), else
 * the proven opencode-go serving lane, else devin/. Duplicate lane twins of a
 * kept id are disabled, never remapped onto the kept id. Ids with no
 * catalogue candidate at all are disabled pending an explicit policy
 * decision -- catalogue absence is necessary but not sufficient evidence, and
 * silent drops are not authorized.
 */
const ALL_CONFIGURED: string[] = [
  "cliproxy/claude-fable-5",
  "cliproxy/claude-opus-5",
  "cliproxy/claude-opus-4-8",
  "cliproxy/claude-opus-4-7",
  "cliproxy/claude-opus-4-6",
  "cliproxy/claude-opus-4-5-20251101",
  "cliproxy/claude-sonnet-5",
  "cliproxy/claude-sonnet-4-6",
  "cliproxy/claude-sonnet-4-5-20250929",
  "cliproxy/claude-haiku-4-5-20251001",
  "cliproxy/claude-sonnet-4-20250514",
  "cliproxy/claude-3-7-sonnet-20250219",
  "cliproxy/claude-3-5-haiku-20241022",
  "cliproxy/gpt-5.4",
  "cliproxy/gpt-5.4-mini",
  "cliproxy/gpt-5.5",
  "cliproxy/gpt-5.6-luna",
  "cliproxy/gpt-5.6-sol",
  "cliproxy/gpt-5.6-terra",
  "cliproxy/gpt-5.3-codex-spark",
  "cliproxy/gpt-oss-120b-medium",
  "cliproxy/gemini-3-flash",
  "cliproxy/gemini-3.1-pro-low",
  "cliproxy/gemini-3.6-flash-high",
  "cliproxy/gemini-3.7-flash-high",
  "cliproxy/grok-4.3",
  "cliproxy/grok-4.5",
  "cliproxy/grok-4.6",
  "cliproxy/kimi-k2",
  "cliproxy/kimi-k2-thinking",
  "cliproxy/kimi-k2.5",
  "cliproxy/kimi-k2.6",
  "cliproxy/kimi-k3",
  "cliproxy/kimi-k3-256k",
  "cliproxy/claude-opus-4-20250514",
  "cliproxy/claude-opus-4-1-20250805",
  "cliproxy/gemini-3.1-flash-lite",
  "cliproxy/gemini-pro-agent",
  "cliproxy/grok-3-mini",
  "cliproxy/grok-3-mini-fast",
  "cliproxy/grok-4.20-0309-non-reasoning",
  "cliproxy/grok-4.20-0309-reasoning",
  "cliproxy/grok-4.20-multi-agent-0309",
  "cliproxy/grok-build-0.1",
  "cliproxy/grok-composer-2.5-fast",
  "cliproxy/kimi-k2.7-code",
  "cliproxy/kimi-k2.7-code-highspeed",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.8-max",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-flash-vision-exp",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/glm-5.3",
  "opencode-go/glm-5.3-flash",
  "opencode-go/kimi-k2.5",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k3",
  "opencode-go/minimax-m2.5",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/grok-4.5",
  "opencode-go/grok-4.6",
  "opencode-go/gpt-5.6-luna",
  "opencode-go/qwen3.5-plus",
  "cliproxy/deepseek-v4-flash",
  "cliproxy/deepseek-v4-flash-vision-exp",
  "cliproxy/deepseek-v4-pro",
  "cliproxy/glm-5",
  "cliproxy/glm-5.1",
  "cliproxy/glm-5.2",
  "cliproxy/glm-5.3",
  "cliproxy/glm-5.3-flash",
  "cliproxy/gpt-5.6-luna-go",
  "cliproxy/grok-4.5-go",
  "cliproxy/grok-4.6-go",
  "cliproxy/hy3",
  "cliproxy/hy3-preview",
  "cliproxy/hy4-preview",
  "cliproxy/kimi-k2.5-go",
  "cliproxy/kimi-k2.6-go",
  "cliproxy/kimi-k2.7-code-go",
  "cliproxy/kimi-k3-go",
  "cliproxy/longcat-2.0",
  "cliproxy/mimo-v2-omni",
  "cliproxy/mimo-v2-pro",
  "cliproxy/mimo-v2.5",
  "cliproxy/mimo-v2.5-pro",
  "cliproxy/minimax-m2.5",
  "cliproxy/minimax-m2.7",
  "cliproxy/minimax-m3",
  "cliproxy/muse-spark-1.2-contributor",
  "cliproxy/muse-spark-1.3-contributor",
  "cliproxy/omen-alpha",
  "cliproxy/qwen3.5-plus",
  "cliproxy/qwen3.6-plus",
  "cliproxy/qwen3.7-max",
  "cliproxy/qwen3.7-plus",
  "cliproxy/qwen3.8-flash",
  "cliproxy/qwen3.8-max",
  "cliproxy/claude-fable-5-1",
  "cliproxy/gpt-6-astra",
  "cliproxy/claude-opus-5-5",
  "cliproxy/gpt-6-sol",
  "cliproxy/gpt-6.1-sol",
  "cliproxy/gpt-6-luna",
  "cliproxy/claude-sonnet-5-5",
  "cliproxy/grok-4.7",
];

const EXPECTED_REMAPS: Array<[string, string]> = [
  ["cliproxy/claude-opus-5", "devin/claude-opus-5"],
  ["cliproxy/claude-opus-4-8", "devin/claude-opus-4-8"],
  ["cliproxy/claude-opus-4-7", "devin/claude-opus-4-7"],
  ["cliproxy/claude-opus-4-6", "devin/claude-opus-4-6"],
  ["cliproxy/claude-sonnet-5", "claude/claude-sonnet-5"],
  ["cliproxy/claude-sonnet-4-6", "devin/claude-sonnet-4-6"],
  ["cliproxy/claude-haiku-4-5-20251001", "claude/claude-haiku-4-5-20251001"],
  ["cliproxy/gpt-5.6-terra", "openai/gpt-5.6-terra"],
  ["cliproxy/gpt-oss-120b-medium", "gpt-oss-120b-medium"],
  ["cliproxy/gemini-3-flash", "gemini-3-flash"],
  ["cliproxy/gemini-3.1-pro-low", "gemini-3.1-pro-low"],
  ["cliproxy/gemini-3.6-flash-high", "gemini-3.6-flash-high"],
  ["cliproxy/gemini-3.7-flash-high", "gemini-3.7-flash-high"],
  ["cliproxy/grok-4.3", "grok-4.3"],
  ["cliproxy/kimi-k2", "kimi-k2"],
  ["cliproxy/kimi-k2-thinking", "kimi-k2-thinking"],
  ["cliproxy/kimi-k3-256k", "kimi-k3-256k"],
  ["cliproxy/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
  ["cliproxy/gemini-pro-agent", "gemini-pro-agent"],
  ["cliproxy/grok-3-mini", "grok-3-mini"],
  ["cliproxy/grok-3-mini-fast", "grok-3-mini-fast"],
  ["cliproxy/grok-4.20-0309-non-reasoning", "grok-4.20-0309-non-reasoning"],
  ["cliproxy/grok-4.20-0309-reasoning", "grok-4.20-0309-reasoning"],
  ["cliproxy/grok-4.20-multi-agent-0309", "grok-4.20-multi-agent-0309"],
  ["cliproxy/grok-build-0.1", "grok-build-0.1"],
  ["cliproxy/grok-composer-2.5-fast", "grok-composer-2.5-fast"],
  ["cliproxy/kimi-k2.7-code-highspeed", "kimi-k2.7-code-highspeed"],
  ["cliproxy/hy3", "opencode-go/hy3"],
  ["cliproxy/hy3-preview", "opencode-go/hy3-preview"],
  ["cliproxy/hy4-preview", "opencode-go/hy4-preview"],
  ["cliproxy/longcat-2.0", "opencode-go/longcat-2.0"],
  ["cliproxy/mimo-v2-omni", "opencode-go/mimo-v2-omni"],
  ["cliproxy/mimo-v2-pro", "opencode-go/mimo-v2-pro"],
  ["cliproxy/mimo-v2.5", "opencode-go/mimo-v2.5"],
  ["cliproxy/mimo-v2.5-pro", "opencode-go/mimo-v2.5-pro"],
  ["cliproxy/muse-spark-1.2-contributor", "meta/muse-spark-1.2-contributor"],
  ["cliproxy/muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor"],
  ["cliproxy/omen-alpha", "opencode-go/omen-alpha"],
  ["cliproxy/qwen3.8-flash", "opencode-go/qwen3.8-flash"],
  ["cliproxy/claude-fable-5-1", "claude/claude-fable-5-1"],
  ["cliproxy/gpt-6-astra", "openai/gpt-6-astra"],
  ["cliproxy/claude-opus-5-5", "claude/claude-opus-5-5"],
  ["cliproxy/gpt-6-sol", "openai/gpt-6-sol"],
  ["cliproxy/gpt-6.1-sol", "openai/gpt-6.1-sol"],
  ["cliproxy/gpt-6-luna", "openai/gpt-6-luna"],
  ["cliproxy/claude-sonnet-5-5", "claude/claude-sonnet-5-5"],
  ["cliproxy/grok-4.7", "grok-4.7"],
];

/**
 * Twin coalescing: two lane labels for one served id. The first source is the
 * deterministic winner when neither twin is enabled; a live enabled twin wins
 * regardless of order (pinned by the mixed-enabled regression below). The
 * loser is disabled, never deleted. Live evidence: the glm-5.3 pair is
 * (disabled opencode-go, enabled cliproxy) -- the exact shape that lost
 * coverage under remap-one/disable-other.
 */
const EXPECTED_MERGES: Array<[string, string, string]> = [
  ["kimi-k2.5", "opencode-go/kimi-k2.5", "cliproxy/kimi-k2.5"],
  ["kimi-k2.6", "opencode-go/kimi-k2.6", "cliproxy/kimi-k2.6"],
  ["kimi-k2.7-code", "opencode-go/kimi-k2.7-code", "cliproxy/kimi-k2.7-code"],
  ["kimi-k3", "opencode-go/kimi-k3", "cliproxy/kimi-k3"],
  ["grok-4.5", "opencode-go/grok-4.5", "cliproxy/grok-4.5"],
  ["grok-4.6", "opencode-go/grok-4.6", "cliproxy/grok-4.6"],
  ["glm-5.3", "opencode-go/glm-5.3", "cliproxy/glm-5.3"],
  ["glm-5.3-flash", "opencode-go/glm-5.3-flash", "cliproxy/glm-5.3-flash"],
];

const EXPECTED_DISABLED: string[] = [
  "cliproxy/deepseek-v4-flash",
  "cliproxy/deepseek-v4-flash-vision-exp",
  "cliproxy/deepseek-v4-pro",
  "cliproxy/qwen3.5-plus",
  "cliproxy/qwen3.6-plus",
  "cliproxy/qwen3.7-max",
  "cliproxy/qwen3.7-plus",
  "cliproxy/qwen3.8-max",
  "cliproxy/minimax-m2.5",
  "cliproxy/minimax-m2.7",
  "cliproxy/minimax-m3",
  "cliproxy/claude-fable-5",
  "cliproxy/claude-opus-4-5-20251101",
  "cliproxy/claude-sonnet-4-5-20250929",
  "cliproxy/claude-sonnet-4-20250514",
  "cliproxy/claude-3-7-sonnet-20250219",
  "cliproxy/claude-3-5-haiku-20241022",
  "cliproxy/gpt-5.4",
  "cliproxy/gpt-5.4-mini",
  "cliproxy/gpt-5.5",
  "cliproxy/gpt-5.6-luna",
  "cliproxy/gpt-5.6-sol",
  "cliproxy/gpt-5.3-codex-spark",
  "cliproxy/claude-opus-4-20250514",
  "cliproxy/claude-opus-4-1-20250805",
  "cliproxy/gpt-5.6-luna-go",
  "cliproxy/grok-4.5-go",
  "cliproxy/grok-4.6-go",
  "cliproxy/kimi-k2.5-go",
  "cliproxy/kimi-k2.6-go",
  "cliproxy/kimi-k2.7-code-go",
  "cliproxy/kimi-k3-go",
  "cliproxy/glm-5",
  "cliproxy/glm-5.1",
  "cliproxy/glm-5.2",
  "opencode-go/glm-5",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/gpt-5.6-luna",
];

const OLD_SECRET = "11111111-1111-4111-8111-111111111111";
const NEW_SECRET = "22222222-2222-4222-8222-222222222222";

interface FlagAction {
  kind: "remap" | "disable" | "merge";
  args: string[];
}

function flagActions(file: string): FlagAction[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).map((line): FlagAction => {
    const remap = line.match(/^--remap (\S+)=(\S+)$/);
    if (remap?.[1] && remap[2]) return { kind: "remap", args: [remap[1], remap[2]] };
    const disable = line.match(/^--disable (\S+)$/);
    if (disable?.[1]) return { kind: "disable", args: [disable[1]] };
    const merge = line.match(/^--merge (\S+) (\S+) (\S+)$/);
    if (merge?.[1] && merge[2] && merge[3]) return { kind: "merge", args: [merge[1], merge[2], merge[3]] };
    throw new Error(`unparseable flag line: ${JSON.stringify(line)}`);
  });
}

/**
 * Runs the transformer exactly the way the operator runbook does: roster
 * actions arrive via --flags-file, never as self-parsed argv. This is the
 * regression pin for the shipped mapfile shape, which silently applied zero
 * roster actions while exiting 0.
 */
function runWithFlagFiles(flagFiles: string[]) {
  return runWith(flagFiles.flatMap((file) => ["--flags-file", file]));
}

/**
 * Mixed-enabled fixture. Enabled flags mirror the live facts the host STOP
 * proved (both cliproxy/glm-5.3 twins enabled, both opencode-go twins
 * disabled) plus synthetic enabled entries on the keep and remap paths, so a
 * coverage regression fails here instead of at apply time. The two cliproxy
 * GLM twins carry a distinctive tier so the survivor's record -- not just its
 * id -- is pinned to the enabled source.
 */
const ENABLED_IDS = new Set([
  "cliproxy/glm-5.3",
  "cliproxy/glm-5.3-flash",
  "opencode-go/qwen3.6-plus",
  "cliproxy/grok-4.3",
]);

function fixtureEntry(id: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { id, tier: "standard", enabled: ENABLED_IDS.has(id) };
  if (id === "cliproxy/glm-5.3" || id === "cliproxy/glm-5.3-flash") entry.tier = "frontier";
  return entry;
}

function runWith(extraArgs: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
  const inputFile = path.join(dir, "backup.json");
  const outputFile = path.join(dir, "payload.json");
  fs.writeFileSync(inputFile, JSON.stringify({
    configJson: {
      upstream: {
        protocol: "openai-chat-completions",
        baseUrl: "https://router.infextion.net",
        credentialSecretRef: { type: "secret_ref", secretId: OLD_SECRET },
        requestTimeoutMs: 25000,
        maxResponseBytes: 8388608,
        extraHeaders: {},
      },
      models: ALL_CONFIGURED.map(fixtureEntry),
    },
  }));
  try {
    execFileSync("node", [SCRIPT, "--input", inputFile, "--output", outputFile,
      "--credential-secret-id", NEW_SECRET, ...extraArgs], { stdio: ["ignore", "ignore", "pipe"] });
    return JSON.parse(fs.readFileSync(outputFile, "utf8")).configJson.models as Array<Record<string, unknown>>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MERGE_SOURCES = EXPECTED_MERGES.flatMap(([, a, b]) => [a, b]);

function keptIds(): string[] {
  const touched = new Set([
    ...EXPECTED_REMAPS.map(([from]) => from),
    ...MERGE_SOURCES,
    ...EXPECTED_DISABLED,
  ]);
  return ALL_CONFIGURED.filter((id) => !touched.has(id));
}

describe("cliproxy full-roster reconciliation", () => {
  it("partitions the 113 configured ids with no overlap and no gaps", () => {
    expect(ALL_CONFIGURED).toHaveLength(113);
    expect(EXPECTED_REMAPS).toHaveLength(47);
    expect(EXPECTED_MERGES).toHaveLength(8);
    expect(EXPECTED_DISABLED).toHaveLength(39);
    const kept = keptIds();
    expect(kept).toHaveLength(11);
    expect(new Set([
      ...EXPECTED_REMAPS.map(([from]) => from),
      ...MERGE_SOURCES,
      ...EXPECTED_DISABLED,
      ...kept,
    ]).size).toBe(113);
    // No remap or merge target may collide with a kept, disabled, or merged id.
    const occupied = new Set([...kept, ...EXPECTED_DISABLED, ...MERGE_SOURCES]);
    for (const [, to] of EXPECTED_REMAPS) expect(occupied.has(to)).toBe(false);
    for (const [target] of EXPECTED_MERGES) expect(occupied.has(target)).toBe(false);
  });

  it("flag files match the expected reconciliation exactly", () => {
    const decided = flagActions(DECIDED_FLAGS);
    expect(decided.every((action) => action.kind === "remap")).toBe(true);
    expect(decided).toHaveLength(47);
    for (const [from, to] of EXPECTED_REMAPS) {
      expect(decided).toContainEqual({ kind: "remap", args: [from, to] });
    }
    const pending = flagActions(PENDING_FLAGS);
    const pendingMerges = pending.filter((action) => action.kind === "merge");
    const pendingDisables = pending.filter((action) => action.kind === "disable");
    expect(pendingMerges).toHaveLength(8);
    expect(pendingDisables).toHaveLength(39);
    for (const [target, a, b] of EXPECTED_MERGES) {
      expect(pendingMerges).toContainEqual({ kind: "merge", args: [target, a, b] });
    }
    for (const id of EXPECTED_DISABLED) {
      expect(pendingDisables).toContainEqual({ kind: "disable", args: [id] });
    }
  });

  it("decided flags remap 47 and leave everything else byte-identical", () => {
    const models = runWithFlagFiles([DECIDED_FLAGS]);
    expect(models).toHaveLength(113);
    const byId = new Map(models.map((model) => [model.id as string, model]));
    for (const [from, to] of EXPECTED_REMAPS) {
      expect(byId.has(from)).toBe(false);
      expect(byId.get(to)).toEqual({ ...fixtureEntry(from), id: to });
    }
    for (const id of [...MERGE_SOURCES, ...EXPECTED_DISABLED, ...keptIds()]) {
      expect(byId.get(id)).toEqual(fixtureEntry(id));
    }
  });

  it("decided + pending flags preserve enabled coverage across merges", () => {
    const models = runWithFlagFiles([DECIDED_FLAGS, PENDING_FLAGS]);
    expect(models).toHaveLength(113);
    const byId = new Map(models.map((model) => [model.id as string, model]));
    // The host STOP shape: an enabled twin survives under the served id with
    // its own record; the disabled twin goes dark. Enabled count is kept.
    for (const target of ["glm-5.3", "glm-5.3-flash"]) {
      expect(byId.get(target)).toMatchObject({ id: target, tier: "frontier", enabled: true });
    }
    // Enabled entries on the keep and remap paths pass through untouched.
    expect(byId.get("opencode-go/qwen3.6-plus")).toMatchObject({ enabled: true });
    expect(byId.get("grok-4.3")).toMatchObject({ enabled: true });
    // Per merge: the target serves the winner's record, exactly one source
    // id survives as the dark loser, the other source id is gone (renamed).
    for (const [target, a, b] of EXPECTED_MERGES) {
      expect(byId.has(target)).toBe(true);
      const survivors = [a, b].filter((id) => byId.has(id));
      expect(survivors).toHaveLength(1);
      const loser = survivors[0];
      if (!loser) throw new Error("merge must leave exactly one dark loser");
      expect(byId.get(loser)).toMatchObject({ id: loser, enabled: false });
    }
    for (const id of EXPECTED_DISABLED) {
      expect(byId.get(id)).toMatchObject({ id, enabled: false });
    }
    for (const id of keptIds()) expect(byId.get(id)).toEqual(fixtureEntry(id));
    const enabledAfter = models.filter((model) => model.enabled === true).map((model) => model.id);
    expect(new Set(enabledAfter)).toEqual(new Set(["glm-5.3", "glm-5.3-flash", "opencode-go/qwen3.6-plus", "grok-4.3"]));
  });
});
