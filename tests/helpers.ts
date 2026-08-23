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
