// TOG-5466: prompt regression eval — candidate bundle (this tree).
//
// This spec pins the CURRENT tree's parse+select outputs on the pinned
// corpus in tests/eval-tog5466/corpus.json. The frozen expectations below
// are the v0.7.0-baseline outputs ALSO where nothing changed, and the new
// TOG-5247 rejection behavior on the six tool-name rows (P22-P26 + P21
// boundary). A future change that alters any pinned row fails here first —
// that is the regression gate.
import { describe, expect, it } from "vitest";

import { parseInvokeRequest } from "../src/inference/validate.js";
import { selectModel } from "../src/engine/select.js";
import { resolveConfig } from "../src/config/resolve.js";
import {
  loadCorpus,
  loadFixtureRaw,
  runAll,
  type BundleFns,
  type EvalRow,
} from "./eval-tog5466/eval-lib.js";

const candidateBundle: BundleFns = {
  resolveConfig: (raw) => resolveConfig(raw),
  parseInvokeRequest: (value, cap, protocol) => parseInvokeRequest(value, cap, protocol),
  selectModel: (input) => selectModel(input as Parameters<typeof selectModel>[0]),
};

const EXPECTED: Record<string, { parse: EvalRow["parse"]; outcome: string | null; modelId: string | null }> = {
  "P01-plain-minimal": { parse: "ok", outcome: "selected", modelId: "qwen3-coder" },
  "P02-system-prompt": { parse: "ok", outcome: "selected", modelId: "qwen3-coder" },
  "P03-stop-sequences": { parse: "ok", outcome: "selected", modelId: "qwen3-coder" },
  "P04-tools-short-auto": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P05-toolchoice-object-short": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P06-metadata": { parse: "ok", outcome: "selected", modelId: "qwen3-coder" },
  "P07-image-escalates-vision": { parse: "ok", outcome: "selected", modelId: "claude-sonnet-5" },
  "P08-image-anthropic-reject": { parse: "invalid-request", outcome: null, modelId: null },
  "P09-tool-loop-turn": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P10-signals-tier": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P11-pin-honored": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P12-pin-unknown-id": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P13-pin-blocklisted": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P14-estimates-cost": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P15-architecture-floor": { parse: "ok", outcome: "selected", modelId: "claude-sonnet-5" },
  "P16-context-unmet": { parse: "ok", outcome: "no-eligible-model", modelId: null },
  "P17-rule0-hit": { parse: "ok", outcome: "no-model-needed", modelId: null },
  "P18-unknown-top-field": { parse: "invalid-request", outcome: null, modelId: null },
  "P19-empty-messages": { parse: "invalid-request", outcome: null, modelId: null },
  "P20-maxtokens-over-cap": { parse: "invalid-request", outcome: null, modelId: null },
  "P21-name-64-def": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  // TOG-5247 intended change: the candidate rejects these where v0.7.0 parsed ok.
  "P22-name-65-def": { parse: "invalid-request", outcome: null, modelId: null },
  "P23-name-90-def-gateway": { parse: "invalid-request", outcome: null, modelId: null },
  "P24-name-65-toolchoice-object": { parse: "invalid-request", outcome: null, modelId: null },
  "P25-name-90-toolcall-block": { parse: "invalid-request", outcome: null, modelId: null },
  "P26-name-65-second-of-two": { parse: "invalid-request", outcome: null, modelId: null },
  "P27-sticky-incumbent": { parse: "ok", outcome: "selected", modelId: "minimax-m2.5" },
  "P28-vision-required-cap": { parse: "ok", outcome: "selected", modelId: "claude-sonnet-5" },
};

describe("prompt regression eval (TOG-5466)", () => {
  it("candidate bundle matches pinned expectations on all 28 corpus rows", () => {
    const rows = runAll(candidateBundle, loadFixtureRaw());
    expect(rows.map((r) => r.id).sort()).toEqual(loadCorpus().map((c) => c.id).sort());
    for (const row of rows) {
      const want = EXPECTED[row.id];
      expect(want, `no pinned expectation for ${row.id}`).toBeDefined();
      expect({ parse: row.parse, outcome: row.outcome, modelId: row.modelId }, row.id).toEqual(want);
    }
  });

  it("baseline and candidate fixtures are identical", () => {
    const mine = loadFixtureRaw();
    const base = loadFixtureRaw(process.env.TOG5466_BASELINE_DIR);
    expect(base).toEqual(mine);
  });

  it("P22-P26 rejections carry length only, never the offending name", () => {
    const rows = runAll(candidateBundle, loadFixtureRaw());
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ["P22-name-65-def", "P23-name-90-def-gateway", "P24-name-65-toolchoice-object", "P25-name-90-toolcall-block", "P26-name-65-second-of-two"]) {
      const row = byId.get(id)!;
      expect(row.parse).toBe("invalid-request");
      expect(row.parseMessage).toMatch(/64/);
      expect(row.parseMessage).not.toMatch(/g{10}|t{10}|c{10}|u{10}/);
      expect(row.outcome).toBeNull();
      expect(row.modelId).toBeNull();
    }
  });
});
