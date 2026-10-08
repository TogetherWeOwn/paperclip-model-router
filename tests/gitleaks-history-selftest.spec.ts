import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

it("keeps policy and new-match controls when squash history lacks the old object", () => {
  const result = spawnSync("python3", ["scripts/test_gitleaks_history_selftest.py", "-v"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 110_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/\nOK\n$/);
}, 120_000);
