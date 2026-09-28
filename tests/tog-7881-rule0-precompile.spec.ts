import { describe, expect, it } from "vitest";

import { compileRule0Pattern, hasNestedUnboundedQuantifier, Rule0PatternError } from "../src/config/rule0.js";
import { resolveConfig } from "../src/config/resolve.js";
import { matchRule0 } from "../src/engine/select.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

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
    for (const pattern of ["(a+)+$", "(a?)+$", "(ab+c)+", "(a{2,3})+", "((ab)+c)+"]) {
      expect(hasNestedUnboundedQuantifier(pattern), pattern).toBe(true);
      expect(() => compileRule0Pattern(pattern, "tool", 0)).toThrowError(Rule0PatternError);
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
    const result = await definition.onValidateConfig!(rawWithPatterns([{ pattern: "(a+)+$", tool: "evil" }]));
    expect(result.ok).toBe(false);
    expect(result.errors?.join("\n")).toContain("rule0.deterministicPatterns[0]");
    const good = await definition.onValidateConfig!(readFixture("company-a"));
    expect(good.ok).toBe(true);
  });
});
