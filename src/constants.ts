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
export const PLUGIN_VERSION = "0.2.6";

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
 * TOG-149: the family names were added after `claude|anthropic` alone was
 * measured against the live catalogue (1,438 ids on 2026-08-24) and found to
 * MISS 15 real Claude routes that name the model by family only — `aug/opus4.7`,
 * `aug/sonnet5-high`, `aug/fable-5`, `aug/haiku4.5` and siblings. Those ids
 * contain neither "claude" nor "anthropic", so `idNamesClaude` returned false,
 * the Claude block was never entered, and auggie served Claude. That is owner
 * rule 1 broken by an id the pattern simply did not recognise.
 *
 * The operator-run combo CLI has refused these since TOG-151 — its suspicion
 * list is `claude|anthropic|opus|sonnet|haiku|fable|prism` plus `aug/*`. The two
 * layers disagreeing is itself the defect: the combo layer refused what the
 * policy layer was willing to select. This pattern is now the CLI's list.
 *
 * `prism` is a blended auggie route (prism-a carries Claude, prism-b does not).
 * Matching prism-b is a deliberate false positive: a blended route cannot be
 * shown to keep Claude out, the CLI refuses blended routes outright, and the
 * failure direction here is a refusal.
 *
 * Measured before widening, not after: across all 1,438 live ids the added
 * alternatives introduce ZERO matches that are not Claude or Claude-blended.
 *
 * Kept as a source string as well as a RegExp because `src/config/schema.ts`
 * needs it as a JSON Schema `pattern`, and two copies of a security predicate is
 * one copy too many.
 */
export const CLAUDE_ID_PATTERN_SOURCE = "claude|anthropic|opus|sonnet|haiku|fable|prism";

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
 * The provider-routing prefix carried by a model id, or null if it carries none.
 *
 * OmniRoute ids are `<<provider>>/<<model>>` — `oc/claude-opus-5`,
 * `openrouter/anthropic/claude-opus-5`, `aug/opus4.7`. The prefix is not
 * decoration: it is what OmniRoute routes on. A bare id like `claude-opus-5`
 * carries no prefix and is *intended* to be resolved by a combo, which is the
 * form owner rule 3 requires — Paperclip names a MODEL and never picks a
 * provider. Whether a combo actually resolves it is a separate question, and
 * TOG-294 established that assuming the answer is a rule-1 hole. See
 * `claudeComboArmed`.
 */
export function routingPrefixOf(modelId: string): string | null {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return trimmed.slice(0, slash);
}

/**
 * May a Claude-family model with this id be routed at all?
 *
 * This closes the bypass that `CLAUDE_PROVIDER_ALLOWLIST` alone did not.
 * TOG-237 established that a company's config may not be trusted to say WHICH
 * models are Claude, and moved that question into `idNamesClaude`. It left the
 * question one layer up — WHO SERVES a Claude model — resting on `models[].providers`,
 * which is the same kind of company-supplied claim.
 *
 * Reproduced on v0.2.3 before this existed:
 *
 *   { "id": "oc/claude-opus-5", "family": "claude", "providers": ["teamclaude"] }
 *
 * cleared every gate with ZERO claude-block rejections, and when pinned it came
 * back `outcome: "selected"`, `honored: true`. Paperclip would then hand
 * `oc/claude-opus-5` to OmniRoute, which routes on the `oc/` prefix — so
 * opencode serves Claude. The `providers` array is a claim ABOUT the
 * destination; the prefix IS the destination. The gate read the claim and
 * ignored the instruction.
 *
 * So the prefix is checked against the same code allowlist, and deny-by-default:
 * a Claude id may carry a prefix that is itself a sanctioned Claude destination,
 * or no prefix at all PROVIDED a combo is known to resolve it (`comboArmed`).
 * Anything else is refused.
 *
 * The bare-id case used to return `ok` unconditionally, on the stated ground
 * that a bare id "is resolved by a combo". TOG-294 measured that assumption
 * failing against the live router:
 *
 *   - `GET /api/v1/models` lists 1,438 ids, of which ZERO are bare, and
 *     `teamclaude/*` is EMPTY — there is no teamclaude combo, because TOG-153
 *     is not deployed.
 *   - `POST /v1/messages` with `{"model": "claude-sonnet-5"}` nonetheless
 *     returned 200, echoing `"model": "anthropic/claude-sonnet-5"` — an id that
 *     is ALSO absent from the catalogue. Same for `claude-opus-5` and
 *     `claude-fable-5`. So an unlisted bare Claude id does not fail; it is
 *     silently rewritten onto a non-teamclaude Anthropic route and served.
 *
 * A later read explained HOW, without sending another completion. The routing
 * scope exposes `GET /api/v1/providers/{provider}/models`, which answers 200
 * for a provider the router knows and 400 for one it does not:
 *
 *     anthropic -> 200, 0 models        oc         -> 200, 166 models
 *     claude    -> 200, 0 models        openrouter -> 200, 1012 models
 *     cc        -> 200, 0 models        teamclaude -> 400  (unknown provider)
 *
 * `anthropic` is a REGISTERED provider that contributes zero ids to the
 * aggregate catalogue. So "absent from `/api/v1/models`" never meant "not
 * routable" — it meant "no synced model list", and the destination the bare id
 * was rewritten onto was a live provider all along. Catalogue membership is
 * therefore not a containment boundary and must not be used as one.
 *
 * The corollary matters more than the finding: `teamclaude` answering 400 is
 * the one hard piece of evidence that the sanctioned lane does not yet exist.
 * That is a provider-registry fact, checked directly, not inferred from an
 * empty catalogue slice.
 *
 * That is owner rule 1 broken by the exact id form owner rule 3 mandates, which
 * is why it cannot be fixed by banning bare ids. It is fixed by refusing to
 * emit one until the combo that gives it its rule-1 meaning exists.
 *
 * Deliberately NOT conditioned on `claudePaygEnabled`. Enabling PAYG is the
 * owner adding a second leg to a COMBO, per this epic's architecture; it never
 * makes it correct for Paperclip to hardcode a provider into a model id. A
 * company that flips the PAYG flag must not thereby acquire the ability to name
 * `oc/claude-opus-5`.
 */
export function claudeDestinationPermitted(
  modelId: string,
  comboArmed: boolean,
): {
  ok: boolean;
  prefix: string | null;
  reason: "prefix-not-allowed" | "combo-not-armed" | null;
} {
  const prefix = routingPrefixOf(modelId);
  if (prefix === null) {
    return comboArmed
      ? { ok: true, prefix: null, reason: null }
      : { ok: false, prefix: null, reason: "combo-not-armed" };
  }
  return isClaudeProviderAllowed(prefix)
    ? { ok: true, prefix, reason: null }
    : { ok: false, prefix, reason: "prefix-not-allowed" };
}

/**
 * Instance-level assertion that the teamclaude Claude combos exist in OmniRoute.
 *
 * This is the on-switch for the bare-id path above, and it is env-read for the
 * same reason `CLAUDE_PAYG_UNLOCK_ENV` is: the claim being made is about the
 * OWNER's OmniRoute deployment, not about the company running the plugin.
 * Phase 4 installs this plugin into companies whose config the owner does not
 * review; letting a config row assert "the combo exists" would let an installee
 * re-open a rule-1 hole in the owner's infrastructure by editing its own row.
 *
 * Default OFF, and off means the Claude lane is refused rather than routed
 * somewhere unverified. That is the deliberate failure direction: a company
 * that has not deployed the combos gets no Claude, instead of getting Claude
 * from whoever OmniRoute's alias table happens to pick.
 *
 * WHO FLIPS THIS AND ON WHAT EVIDENCE: the operator, after TOG-153 registers
 * teamclaude as an OmniRoute provider AND the Claude combos are mapped, with
 * `TOG-153-verify.sh` green. The check that this was flipped honestly is
 * `teamclaude/*` being non-empty in `GET /api/v1/models` — a routing-scope read
 * that needs no management token, so anyone can audit it. `scripts/claude-lane-preflight.sh`
 * does exactly that read.
 */
export const CLAUDE_COMBO_ARMED_ENV = "MODEL_ROUTER_CLAUDE_COMBO_ARMED";

/** True when the instance operator has declared the teamclaude combos deployed. */
export function claudeComboArmed(env: Record<string, string | undefined>): boolean {
  const raw = env[CLAUDE_COMBO_ARMED_ENV];
  return typeof raw === "string" && raw.trim() === "1";
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
