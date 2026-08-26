import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
}

export function fixtureConfig(name: string): RouterConfig {
  return resolveConfig(readFixture(name));
}
