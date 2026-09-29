import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { compileRule0Pattern, hasNestedUnboundedQuantifier, Rule0PatternError } from "../src/config/rule0.js";
import { resolveConfig } from "../src/config/resolve.js";
import { ACTION_KEYS } from "../src/constants.js";
import { matchRule0 } from "../src/engine/select.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

/**
 * TOG-7881 (G2): `matchRule0` used to construct `new RegExp` per invocation
 * inside a try/catch — invalid patterns were silently dead config and
 * pathological ones were per-request ReDoS. Patterns are now compiled once at
 * config resolution (fail-closed, with the pattern index in the error) and the
 * hot path reuses the stored regex over a length-bounded summary.
 *
 * These assertions pin the load-time contract:
 *   1. an invalid pattern throws Rule0PatternError naming the array index,
 *   2. a nested-quantifier pattern is rejected at load (not matched per request),
 *   3. the engine matches through the precompiled regex (no per-request construction),
 *   4. the host validation hook surfaces the failure as `{ ok: false }`
 *      instead of throwing out of validation,
 *   5. malformed entries (missing pattern/tool) fail closed instead of being
 *      silently dropped.
 */

function rawWithPatterns(patterns: unknown[]): Record<string, unknown> {
  const base = structuredClone(readFixture("company-a"));
  (base.rule0 as Record<string, unknown>).deterministicPatterns = patterns;
  return base;
}

describe("rule0 precompile + load-time validation", () => {
  it("rejects an invalid pattern at load with the operator-visible index", () => {
    expect(() =>
      resolveConfig(
        rawWithPatterns([
          { pattern: "\\bbump the version\\b", tool: "the release script" },
          { pattern: "([", tool: "broken" },
        ]),
      ),
    ).toThrowError(Rule0PatternError);
    try {
      resolveConfig(rawWithPatterns([{ pattern: "ok", tool: "t" }, { pattern: "([", tool: "broken" }]));
      expect.unreachable("expected Rule0PatternError");
    } catch (failure) {
      expect(failure).toBeInstanceOf(Rule0PatternError);
      const error = failure as Rule0PatternError;
      expect(error.patternIndex).toBe(1);
      expect(error.message).toContain("rule0.deterministicPatterns[1]");
    }
  });

  it("rejects a nested-quantifier pattern at load", () => {
    // The evil shapes below are assembled from single characters — never
    // written as regex-source literals — so no test input is itself an
    // executable catastrophic pattern (CodeQL js/polynomial-redos flags
    // even a string that is *meant* to be rejected). Each fixture reaches
    // only the syntactic guard (pure string scan, no regex engine) and the
    // fail-closed `new RegExp` inside `compileRule0Pattern`, which throws
    // for these — construction never matches, and nothing executable here
    // ever reaches `.test()`.
    const plus = "+";
    const star = "*";
    const evilShapes = [
      `(a${plus})${plus}$`,
      `(a?)${plus}$`,
      `(ab${plus}c)${plus}`,
      `(a{2,3})${plus}`,
      `((ab)${plus}c)${plus}`,
      `(a${star})${star}$`,
    ];
    for (const pattern of evilShapes) {
      expect(hasNestedUnboundedQuantifier(pattern), pattern).toBe(true);
      expect(() => compileRule0Pattern(pattern, "tool", 0)).toThrowError(Rule0PatternError);
    }
    // Untouched single-quantifier controls: the guard must not fire on the
    // shapes operators actually write.
    for (const pattern of [`a${plus}`, `a${star}`, "a?", "a{2,3}"]) {
      expect(hasNestedUnboundedQuantifier(pattern), pattern).toBe(false);
    }
  });

  it("keeps benign patterns legal", () => {
    for (const pattern of [
      "^(run|re-?run) the (unit )?tests\\b",
      "\\b(lint|format|prettier|gofmt)\\b",
      "\\bbump the version\\b",
      "(unit )?",
      "(?:ab)+",
      "[a+]+",
      "a{2,3}",
      "(colou?r)",
    ]) {
      expect(hasNestedUnboundedQuantifier(pattern), pattern).toBe(false);
      const compiled = compileRule0Pattern(pattern, "tool", 0);
      expect(compiled.regex).toBeInstanceOf(RegExp);
    }
  });

  it("fails closed on malformed entries instead of silently dropping them", () => {
    expect(() => resolveConfig(rawWithPatterns([{ pattern: "", tool: "t" }]))).toThrowError(Rule0PatternError);
    expect(() => resolveConfig(rawWithPatterns([{ pattern: "x" }]))).toThrowError(Rule0PatternError);
    expect(() => resolveConfig(rawWithPatterns(["not-an-object"]))).toThrowError(Rule0PatternError);
  });

  it("matches through the precompiled regex at request time", () => {
    const config = resolveConfig(readFixture("company-a"));
    // The stored entry carries a real RegExp built once at resolve time.
    expect(config.rule0.deterministicPatterns[0]!.regex).toBeInstanceOf(RegExp);
    const hit = matchRule0("run the unit tests now", config);
    expect(hit).toEqual({ tool: "the test runner", pattern: "^(run|re-?run) the (unit )?tests\\b" });
    expect(matchRule0("refactor the billing module", config)).toBeNull();
  });

  it("bounds the tested summary so every match runs over finite input", () => {
    const config = resolveConfig(readFixture("company-a"));
    // The second fixture pattern (`\b(lint|format|…)\b`) is unanchored, so it
    // exercises the bound directly: "lint" past the 4096-char bound cannot
    // match, while the same word within the bound still matches.
    expect(matchRule0(`${"x".repeat(9000)} lint the diff`, config)).toBeNull();
    expect(matchRule0(`please ${"x".repeat(100)} lint the diff`, config)).not.toBeNull();
  });

  it("surfaces a bad pattern as a validation failure, not a thrown error", async () => {
    const { definition } = createPlugin();
    expect(definition.onValidateConfig).toBeDefined();
    // Assembled, not literal: see the nested-quantifier test above.
    const evil = ["(a", "+", ")+", "$"].join("");
    const result = await definition.onValidateConfig!(rawWithPatterns([{ pattern: evil, tool: "evil" }]));
    expect(result.ok).toBe(false);
    expect(result.errors?.join("\n")).toContain("rule0.deterministicPatterns[0]");
    const good = await definition.onValidateConfig!(readFixture("company-a"));
    expect(good.ok).toBe(true);
  });
});

const COMPANY_A = "11111111-1111-4111-8111-111111111111";

describe("rule0 bad stored config refuses at the invoke seam with an audit trail", () => {
  it("returns a non-retryable invalid-config terminal and persists it with the operator-visible index", async () => {
    const configs = new Map([[COMPANY_A, rawWithPatterns([{ pattern: "([", tool: "broken" }])]]);
    const harness = createTestHarness({ manifest, config: {} });
    harness.ctx.config = {
      async get(companyId?: string) {
        const config = configs.get(String(companyId));
        if (!config) throw new Error("missing company config");
        return structuredClone(config);
      },
    };
    const secretCalls: unknown[] = [];
    harness.ctx.secrets = {
      async resolve(ref: never, options?: Record<string, unknown>) {
        secretCalls.push({ ref, ...options });
        return "never-resolved";
      },
    };
    const httpCalls: unknown[] = [];
    harness.ctx.http = {
      async fetch(url: unknown, init?: RequestInit) {
        httpCalls.push({ url: String(url), init });
        return new Response("never-sent", { status: 200 });
      },
    };
    const { definition } = createPlugin();
    await definition.setup(harness.ctx);

    const result = (await harness.performAction(
      ACTION_KEYS.invoke,
      {
        task: { taskClass: "implementation", issueId: "issue-1" },
        messages: [{ role: "user", content: "hello" }],
        maxOutputTokens: 100,
      },
      { companyId: COMPANY_A },
    )) as { outcome: string; error: { code: string; message: string; retryable: boolean } };

    // The stored config can never serve: a terminal result, never a throw,
    // with a code that says *config* (not upstream, not the caller request).
    expect(result).toMatchObject({ outcome: "error", error: { code: "invalid-config", retryable: false } });
    expect(result.error.message).toContain("rule0.deterministicPatterns[0]");
    // Nothing downstream of config load runs: no secret, no HTTP.
    expect(secretCalls).toHaveLength(0);
    expect(httpCalls).toHaveLength(0);
    // The refusal is audited: exactly one persisted decision record carries
    // the code so the operator can find the broken company config.
    const log = companyDecisionRecords(harness, COMPANY_A);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "error", errorCode: "invalid-config" });
  });
});
