import type { Rule0Pattern } from "./types.js";

/**
 * TOG-7881 (G2): Rule 0 patterns used to be constructed with `new RegExp`
 * per `matchRule0` invocation inside a try/catch. Invalid patterns were
 * silently dead config, and pathological ones were a per-request ReDoS.
 * Patterns are now compiled once at config resolution (fail-closed, with
 * the pattern index in the error) and matched against a length-bounded
 * summary, so the hot path never constructs a regex.
 */

/** Longest accepted pattern source. Operator patterns are short literals and alternations; anything longer is a mistake, not a pattern. */
export const MAX_RULE0_PATTERN_LENGTH = 512;
/**
 * Longest task summary the engine tests against a Rule 0 pattern.
 * Combined with the nested-quantifier rejection below, this bounds every
 * Rule 0 match: the dangerous pattern class is refused at load, and the
 * input size is capped per request.
 */
export const MAX_RULE0_SUMMARY_LENGTH = 4096;

/** Fail-closed config error: carries the operator-visible array index. */
export class Rule0PatternError extends Error {
  readonly patternIndex: number;
  readonly pattern: string;
  constructor(patternIndex: number, pattern: string, reason: string) {
    super(`rule0.deterministicPatterns[${patternIndex}]: ${reason}`);
    this.name = "Rule0PatternError";
    this.patternIndex = patternIndex;
    this.pattern = pattern;
  }
}

/**
 * True when a quantified group `(...)` (or `(?:...)`, lookaround, etc.)
 * contains a repeated element anywhere inside it — the nested-quantifier
 * shape behind catastrophic backtracking (`(a+)+$`, `(a?)+$`, `(ab+c)+`,
 * `(a{2,3})+`, `((ab)+c)+`). Any inner repetition counts, bounded or not:
 * `(a{2,3})+` still partitions its input combinatorially, so `{m}` and
 * `{m,n}` are rejected exactly like `*`, `+`, `?` and `{m,}` when nested
 * under a quantifier. Escapes and character classes are skipped, so
 * `\(literal\)`, `[a+]+` and bare `a{2,3}` stay legal. A bare `?` counts as
 * repetition here on purpose: `(a?)+$` is textbook-exponential. Only a
 * group that is itself quantified is rejected — unquantified groups with
 * inner repetition (`(unit )?`, `(colou?r)`, `(run|re-?run)`) are
 * unaffected.
 *
 * Deliberately conservative: the check is syntactic, so a benign
 * optional-element-under-quantifier such as `(colou?r)+` (deterministic in
 * practice) is rejected alongside the genuinely exponential `(a?)+`. The
 * error message says how to rewrite it. Operator Rule 0 patterns are short
 * literals and alternations by construction, so this costs nothing real.
 *
 * Residual risk (documented, not checked): ambiguous alternation under a
 * quantifier (`(a|aa)+$`) backtracks exponentially with no nested
 * quantifier for this scan to see, as does an optional group overlapping
 * its sibling under an outer quantifier (`((a)?a)+`). Operator patterns
 * must keep quantified alternatives disjoint; every Rule 0 match
 * additionally runs over an input capped at {@link MAX_RULE0_SUMMARY_LENGTH}
 * characters.
 */
export function hasNestedUnboundedQuantifier(source: string): boolean {
  const groupHasRepetition: boolean[] = [];
  const markRepetition = (): void => {
    if (groupHasRepetition.length > 0) groupHasRepetition[groupHasRepetition.length - 1] = true;
  };
  // True when the `?` at `index` is group syntax (`(?:`, `(?=`, `(?!`,
  // `(?<…`, `(?#…`) rather than a quantifier: in a valid pattern a `?`
  // directly after an unescaped `(` always opens a group construct — a real
  // quantifier needs something to quantify, so `(?:ab)+` stays legal. The
  // backslash parity check sees through escaped parens, so `\(?` (an
  // optional literal paren) still counts as a quantifier. Only `?` needs
  // this — `*`, `+` and `{` can never open a group in a valid pattern (and
  // validity is already established by the RegExp construction before this
  // check runs).
  const isGroupSyntaxQuestion = (at: number): boolean => {
    if (source[at - 1] !== "(") return false;
    let backslashes = 0;
    for (let j = at - 2; j >= 0 && source[j] === "\\"; j -= 1) backslashes += 1;
    return backslashes % 2 === 0;
  };
  let inClass = false;
  let index = 0;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      index += 1;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      index += 1;
      continue;
    }
    if (ch === "(") {
      groupHasRepetition.push(false);
      index += 1;
      continue;
    }
    if (ch === ")") {
      const innerRepetition = groupHasRepetition.pop() ?? false;
      const next = source[index + 1];
      const quantified =
        next === "*" || next === "+" || next === "?" ||
        (next === "{" && /^\{\d/.test(source.slice(index + 1, index + 9)));
      if (innerRepetition && quantified) return true;
      // The group's own quantifier (if any) is itself repetition inside
      // the enclosing group: `((ab)+c)+` is dangerous even though `(ab)`
      // alone is innocent.
      if (quantified && (next === "*" || next === "+" || /^\{\d/.test(source.slice(index + 1, index + 17)))) {
        markRepetition();
      } else if (innerRepetition) {
        markRepetition();
      }
      index += 1;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") {
      // A `?` that opens a group construct (`(?:`, `(?=`, …) is syntax, not
      // a quantifier — see isGroupSyntaxQuestion above.
      if (ch !== "?" || !isGroupSyntaxQuestion(index)) markRepetition();
      index += 1;
      continue;
    }
    if (ch === "{") {
      const match = /^\{(\d+)(,(\d*)?)?\}/.exec(source.slice(index, index + 18));
      if (match) {
        // Any counted repetition is repetition for nesting purposes:
        // `(a{2,3})+` still partitions its input combinatorially.
        markRepetition();
        index += match[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return false;
}

/** Compile one configured pattern, fail-closed with its array index. */
export function compileRule0Pattern(pattern: string, tool: string, index: number): Rule0Pattern {
  if (pattern.length > MAX_RULE0_PATTERN_LENGTH) {
    throw new Rule0PatternError(index, pattern, `pattern exceeds ${MAX_RULE0_PATTERN_LENGTH} characters`);
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : "invalid regular expression";
    throw new Rule0PatternError(index, pattern, `pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${detail}`);
  }
  if (hasNestedUnboundedQuantifier(pattern)) {
    throw new Rule0PatternError(
      index,
      pattern,
      `pattern ${JSON.stringify(pattern)} nests an unbounded quantifier inside a quantified group (catastrophic-backtracking risk); simplify it to literals, alternations, or bounded repetition`,
    );
  }
  return { pattern, tool, regex };
}

/** Cap the tested input so every Rule 0 match runs over a bounded string. */
export function boundRule0Summary(summary: string): string {
  return summary.length > MAX_RULE0_SUMMARY_LENGTH ? summary.slice(0, MAX_RULE0_SUMMARY_LENGTH) : summary;
}
