// TOG-5466: prompt regression eval library. Pure parse+select over a pinned
// corpus — no upstream calls, no SDK harness, no host. Importable from both
// the vitest spec (candidate bundle = this tree) and a tsx runner pointed at
// the v0.7.0 baseline tree via --bundle-dir. Shared so the two bundles execute
// byte-identical eval logic; only the src/ under test differs.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalCase {
  id: string;
  configPatch?: Record<string, unknown>;
  protocol?: "openai-chat-completions" | "anthropic-messages";
  expectParse?: "invalid-request";
  expectOutcome?: string;
  intendedChange?: string;
  signals?: Record<string, unknown>;
  request: Record<string, unknown>;
}

export interface EvalRow {
  id: string;
  parse: "ok" | "invalid-request" | "other-error";
  parseMessage: string | null;
  outcome: string | null;
  modelId: string | null;
  trace: string[];
  rejections: Array<{ modelId: string; stage: string; reason: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));

type Expansion = string | number | boolean | null | Expansion[] | { [k: string]: Expansion };

function expandNode(node: unknown): Expansion {
  if (Array.isArray(node)) return node.map(expandNode);
  if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if ("$repeat" in rec) {
      const spec = rec.$repeat as { ch: string; n: number };
      return spec.ch.repeat(spec.n);
    }
    if ("$concat" in rec) {
      const parts = rec.$concat as unknown[];
      return parts.map((p) => String(expandNode(p))).join("");
    }
    const out: Record<string, Expansion> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = expandNode(v);
    return out;
  }
  return node as Expansion;
}

export function loadCorpus(): EvalCase[] {
  const raw = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8")) as { cases: EvalCase[] };
  return raw.cases.map((c) => ({ ...c, request: expandNode(c.request) as Record<string, unknown> }));
}

// Fixture is loaded from the BUNDLE under test: the candidate tree's own
// tests/fixtures/company-a.json (or the baseline tree's, via bundleDir).
// The two fixtures must be identical; the spec asserts that.
export function loadFixtureRaw(bundleDir?: string): Record<string, unknown> {
  const root = bundleDir ? resolve(bundleDir) : resolve(here, "..", "..");
  return JSON.parse(readFileSync(join(root, "tests", "fixtures", "company-a.json"), "utf8"));
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) &&
        out[k] !== null && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface BundleFns {
  resolveConfig: (raw: unknown) => { routing: { maxOutputTokens: number } };
  parseInvokeRequest: (
    value: unknown,
    cap: number,
    protocol?: "openai-chat-completions" | "anthropic-messages",
  ) => { task: unknown; maxOutputTokens: number };
  selectModel: (input: { descriptor: unknown; config: unknown; signals?: unknown }) => {
    outcome: string; modelId: string | null; trace: string[];
    rejections: Array<{ modelId: string; stage: string; reason: string }>;
  };
}

export function runCase(bundle: BundleFns, fixtureRaw: Record<string, unknown>, c: EvalCase): EvalRow {
  const merged = c.configPatch ? deepMerge(fixtureRaw, c.configPatch) : fixtureRaw;
  const config = bundle.resolveConfig(merged);
  const cap = config.routing.maxOutputTokens;
  let parsed: { task: unknown; maxOutputTokens: number };
  try {
    parsed = bundle.parseInvokeRequest(structuredClone(c.request), cap, c.protocol);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = /unknown field|must be|must contain|exceeds|not supported|is not|required|ceiling|characters/.test(msg)
      ? "invalid-request"
      : "other-error";
    return { id: c.id, parse: kind, parseMessage: msg, outcome: null, modelId: null, trace: [], rejections: [] };
  }
  const decision = bundle.selectModel({
    descriptor: parsed.task,
    config,
    signals: (c.signals ?? {}) as Record<string, unknown>,
  });
  return {
    id: c.id,
    parse: "ok",
    parseMessage: null,
    outcome: decision.outcome,
    modelId: decision.modelId,
    trace: decision.trace,
    rejections: decision.rejections,
  };
}

export function runAll(bundle: BundleFns, fixtureRaw: Record<string, unknown>): EvalRow[] {
  return loadCorpus().map((c) => runCase(bundle, fixtureRaw, c));
}
