/**
 * Stable identifiers for the plugin. Everything here is code, not configuration:
 * these values are the same in every company the plugin is installed for.
 *
 * Anything that legitimately differs between companies belongs in
 * `src/config/schema.ts` and is supplied per company through
 * `POST /api/plugins/:pluginId/config`.
 */

export const PLUGIN_ID = "togetherweown.paperclip-model-router";

/** Kept in sync with package.json by `npm run verify` (see tests/manifest.spec.ts). */
export const PLUGIN_VERSION = "0.2.3";

/** Host plugin API generation this manifest targets. */
export const PLUGIN_API_VERSION = 1 as const;

/** `ctx.data.register` keys. */
export const DATA_KEYS = {
  /** Effective, defaulted configuration for a company. */
  effectiveConfig: "effective-config",
  /** Recent routing decisions recorded for a company. */
  decisions: "decisions",
  /** Quota-gate view for a company. */
  quota: "quota",
} as const;

/** `ctx.actions.register` keys. */
export const ACTION_KEYS = {
  /** Produce a routing decision for a task descriptor. */
  route: "route",
  /** Re-read the teamclaude quota snapshot for a company. */
  refreshQuota: "refresh-quota",
} as const;

/** Agent-facing tool names. */
export const TOOL_NAMES = {
  selectModel: "model_router_select",
} as const;

/** Scoped API route keys (served under /api/plugins/:pluginId/api/...). */
export const ROUTE_KEYS = {
  routeIssue: "route-issue",
  companyConfig: "company-config",
} as const;

/** Plugin state keys, all written under `scopeKind: "company"`. */
export const STATE_KEYS = {
  /** Ring buffer of recent decisions, for audit and for the UI. */
  decisionLog: "decision-log",
  /** Last teamclaude quota snapshot and the gate level derived from it. */
  quotaSnapshot: "quota-snapshot",
  /** Model chosen for an issue, so a mid-task switch does not destroy the prompt cache. */
  issueStickiness: "issue-stickiness",
} as const;

/** How many decisions to retain per company in `STATE_KEYS.decisionLog`. */
export const DECISION_LOG_LIMIT = 200;

/**
 * A model id that names Anthropic's family, whatever the config calls it.
 *
 * This is code, deliberately, and it is the reason owner rule 1 no longer rests
 * on configuration. `models[].family` is company-supplied: an operator who typed
 * `{ "id": "claude-opus-5", "family": "gpt" }` used to get a Claude model served
 * by OpenRouter with `outcome: "selected"`, no rejection and no trace line. The
 * gate did not fail — it was never asked. See TOG-237.
 *
 * The engine now classifies a model as Claude if EITHER this pattern matches its
 * id OR its declared family is in `providers.claudeFamilies`. The union is the
 * point: configuration can still widen the Claude block to cover a model whose
 * id does not say "claude", but it can no longer narrow it off a model whose id
 * does. A mislabel becomes a config error, not a bypass.
 *
 * The cost of keying on the id is a non-Anthropic model with "claude" or
 * "anthropic" in its name being wrongly confined to `claudeFamilyProvider`.
 * Checked rather than assumed, against the OmniRoute catalogue read on
 * 2026-08-22 (1,422 ids): 337 ids match this pattern and all 153 distinct model
 * names among them are Anthropic Claude models. There is no false positive to
 * confine. Re-check this if the catalogue gains a third-party model that borrows
 * the name — the failure mode is a refusal, which is the safe direction.
 *
 * Kept as a source string as well as a RegExp because `src/config/schema.ts`
 * needs it as a JSON Schema `pattern`, and two copies of a security predicate is
 * one copy too many.
 */
export const CLAUDE_ID_PATTERN_SOURCE = "claude|anthropic";

/** `CLAUDE_ID_PATTERN_SOURCE` as a case-insensitive matcher. */
export const CLAUDE_ID_PATTERN = new RegExp(CLAUDE_ID_PATTERN_SOURCE, "i");

/**
 * The same pattern with case-insensitivity written into the alternation itself.
 *
 * JSON Schema `pattern` is an ECMA regex with NO flags — there is no way to ask
 * draft-07 for `/i`. Shipping the bare source into the schema would have made it
 * match `claude-opus-5` and miss `CLAUDE_4_5_HAIKU`, and a case-sensitive Claude
 * check is the exact defect TOG-228 closed one layer down. Derived here rather
 * than hand-written so the two forms cannot drift; `tests/config.spec.ts` holds
 * them to the same answers.
 */
export const CLAUDE_ID_PATTERN_SOURCE_ANY_CASE = CLAUDE_ID_PATTERN_SOURCE.replace(
  /[a-z]/g,
  (character) => `[${character.toUpperCase()}${character}]`,
);

/** True when a model id names Anthropic's family regardless of its declared `family`. */
export function idNamesClaude(modelId: string): boolean {
  return CLAUDE_ID_PATTERN.test(modelId);
}

/**
 * The providers permitted to serve a Claude-family model while Claude PAYG is off.
 *
 * TOG-237 moved the question "which models are Claude" out of configuration and
 * into code. It left the two questions either side of it in configuration, and
 * both of them decide the same outcome:
 *
 *   - WHERE the block points: `providers.claudeFamilyProvider`, a free-form
 *     string. Setting it to `"openrouter"` did not disable the block — it aimed
 *     it. A Claude model that teamclaude cannot serve was then `selected`, with
 *     no rejection and no trace line, and the trace that did print read
 *     "may only be served by openrouter" as though that were the rule.
 *   - WHETHER it runs at all: `providers.claudePaygEnabled`, a per-company
 *     boolean that skipped the branch outright and produced a warning, not an
 *     error.
 *
 * Both reproduced on v0.2.2. Owner rule 1 says Claude runs on teamclaude only
 * and that PAYG stays disabled until the OWNER enables it — so neither of those
 * may be a company's decision to make. Phase 4 installs this plugin into other
 * companies, whose config the owner does not review; a rule enforced by a field
 * the installee sets is not enforced.
 *
 * Configuration may still NARROW this list — `claudeFamilyProvider` picks one
 * entry from it — and can no longer widen it. A value outside this list
 * intersects to the empty set and the model is blocked, so the failure
 * direction is a refusal.
 *
 * This is the list to edit if the owner's answer to `rule1_scope` is the
 * permissive reading (adding `"opencode"` for `oc/claude-*`). That is a
 * one-line change here, deliberately: the enforcement architecture does not
 * depend on which way that question is answered, only its contents do.
 */
export const CLAUDE_PROVIDER_ALLOWLIST: readonly string[] = ["teamclaude"];

/**
 * True when `provider` may serve Claude while PAYG is off.
 *
 * Compared case-insensitively. A case-sensitive Claude comparison is the exact
 * defect TOG-228 closed one layer down, and `permitted` lists are typed by hand.
 */
export function isClaudeProviderAllowed(provider: string): boolean {
  const needle = provider.trim().toLowerCase();
  return CLAUDE_PROVIDER_ALLOWLIST.some((entry) => entry.toLowerCase() === needle);
}

/**
 * Instance-level unlock for Claude PAYG.
 *
 * Read from the process environment, which a company's plugin config row cannot
 * write. Without it, `providers.claudePaygEnabled: true` is refused at config
 * write and ignored by the engine if it was persisted some other way.
 *
 * Note for whoever enables Claude PAYG later: per this epic's architecture that
 * is an EDIT TO AN OMNIROUTE COMBO — adding a second leg to the teamclaude
 * combo — not a plugin change, and the plugin should still be naming a model
 * rather than choosing a provider. This unlock exists to make the flag
 * owner-controlled rather than company-controlled; it is not an invitation to
 * route Claude PAYG from here.
 */
export const CLAUDE_PAYG_UNLOCK_ENV = "MODEL_ROUTER_CLAUDE_PAYG_UNLOCK";

/** True when the instance operator has unlocked Claude PAYG for this process. */
export function claudePaygUnlocked(env: Record<string, string | undefined>): boolean {
  const raw = env[CLAUDE_PAYG_UNLOCK_ENV];
  return typeof raw === "string" && raw.trim() === "1";
}
