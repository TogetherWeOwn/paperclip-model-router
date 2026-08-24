import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Raw fixture, exactly as an operator would POST it to the plugin config route. */
export function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
}

export function fixtureConfig(
  name: string,
  env: Record<string, string | undefined> = {},
): RouterConfig {
  return resolveConfig(readFixture(name), env);
}

/**
 * An instance environment where the owner has unlocked Claude PAYG.
 *
 * `providers.claudePaygEnabled` is no longer sufficient on its own — a company
 * config row is not the owner, so the flag only takes effect alongside this.
 * Fixtures that mean "a company running with PAYG genuinely enabled" have to
 * say which instance they are running on. See `CLAUDE_PROVIDER_ALLOWLIST`.
 */
export const PAYG_UNLOCKED: Record<string, string> = {
  MODEL_ROUTER_CLAUDE_PAYG_UNLOCK: "1",
};

/**
 * An instance whose OmniRoute has the teamclaude Claude combos deployed.
 *
 * Nearly every test below asserts what the router does with a WORKING Claude
 * lane, so nearly every test needs this. That is not boilerplate — it is the
 * finding from TOG-294 written into the fixtures. A bare Claude id only means
 * "teamclaude" once a combo says so; on an instance where TOG-153 has not been
 * deployed the same id is resolved by the router's alias table onto a
 * non-teamclaude Anthropic route and served without error.
 *
 * Tests that deliberately omit this are asserting the undeployed case, and they
 * expect a `claude-block` refusal rather than a route.
 */
export const CLAUDE_COMBO_DEPLOYED: Record<string, string> = {
  MODEL_ROUTER_CLAUDE_COMBO_ARMED: "1",
};

/** A company running with PAYG genuinely enabled AND the combos deployed. */
export const PAYG_UNLOCKED_AND_DEPLOYED: Record<string, string> = {
  ...PAYG_UNLOCKED,
  ...CLAUDE_COMBO_DEPLOYED,
};
