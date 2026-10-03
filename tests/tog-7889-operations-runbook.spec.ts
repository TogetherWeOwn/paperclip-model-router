/**
 * TOG-7889 (gap G19): docs/OPERATIONS.md is copy-pasted onto a live instance,
 * so each procedure it prints has to be one the stock host actually accepts.
 * The rewrite fixed four that did not, and each fix is pinned here by the
 * command shape that went wrong. Each fix is cited to host source in the doc.
 *
 * - Upgrade: `POST /api/plugins/:id/upgrade` re-reads the package from the
 *   plugin row's `package_path`. Without repointing that row first, the
 *   "upgrade" reloads the old build. The v0.5.0 deployment recorded exactly that.
 * - Rollback: `plugin install "$OLD_DIR"` is refused with 409 while the plugin
 *   key is live (`plugin-registry.ts` `install`), so it is not a rollback.
 * - Config restore: the config POST takes `{configJson}`. The saved file is the
 *   whole PluginConfig record, so `jq -c .` posts the wrong shape.
 * - Refresh SLO: pre-002 rows and capacity-off decisions record age NULL /
 *   stale false. Counting them in the denominator dilutes the stale share
 *   (0.4 instead of 0.667 on the five-row fixture), and an empty window must
 *   not divide by zero.
 *
 * The section is sliced by heading, so a fix that drifts into another
 * section is still caught. These are command-shape pins, not a parser:
 * prose may change freely around them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const operations = readFileSync(join(repo, "docs/OPERATIONS.md"), "utf8");

/** The body of one `## ` section, heading excluded; fails loudly if renamed. */
function section(heading: string): string {
  const lines = operations.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  expect(start, `docs/OPERATIONS.md lost its "## ${heading}" section`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("docs/OPERATIONS.md runbook (TOG-7889)", () => {
  it("builds with NODE_ENV unset before npm ci", () => {
    const build = section("Build and validate");
    const unset = build.indexOf("unset NODE_ENV");
    expect(unset, "agent containers preset NODE_ENV=production; npm ci then drops devDeps").toBeGreaterThanOrEqual(0);
    expect(build.indexOf("npm ci")).toBeGreaterThan(unset);
    expect(build).toMatch(/npm run verify/);
  });

  it("repoints package_path before the ordinary upgrade", () => {
    const install = section("Release, pin, install");
    const repoint = install.indexOf("UPDATE plugins SET package_path");
    const upgrade = install.indexOf("paperclipai plugin upgrade");
    expect(repoint, "the upgrade re-reads package_path; it must be repointed first").toBeGreaterThanOrEqual(0);
    expect(upgrade).toBeGreaterThan(repoint);
  });

  it("pins the same sha256 in the pin check and the download", () => {
    const install = section("Release, pin, install");
    const pinned = install.match(/--expect-sha256 ([0-9a-f]{64})/)?.[1];
    const checked = install.match(/echo "([0-9a-f]{64}) {2}\$TGZ" \| sha256sum -c -/)?.[1];
    expect(pinned).toBeDefined();
    expect(checked).toBe(pinned);
  });

  it("rolls the package back by package_path, never by reinstalling over a live key", () => {
    const rollback = section("Rollback");
    expect(rollback).not.toMatch(/^\s*npx paperclipai plugin install\b/m);
    const repoint = rollback.indexOf("UPDATE plugins SET package_path");
    expect(repoint).toBeGreaterThanOrEqual(0);
    expect(rollback.indexOf("paperclipai plugin upgrade")).toBeGreaterThan(repoint);
  });

  it("restores config by posting configJson from the backup, not the whole record", () => {
    const rollback = section("Rollback");
    expect(rollback).toContain(`--payload-json "$(jq -c '{configJson}' "$BACKUP")"`);
    expect(rollback).not.toMatch(/jq -c \. "\$BACKUP"/);
  });

  it("counts only capacity-routed decisions in the SLO stale share, NULL-safe", () => {
    const slo = section("Capacity-snapshot refresh SLO (TOG-7885)");
    const sql = slo.match(/```sql\n([\s\S]*?)```/)?.[1];
    expect(sql, "the SLO section lost its SQL block").toBeDefined();
    expect(sql).toMatch(/\/\s*NULLIF\(count\(\*\), 0\)/);
    expect(sql).toMatch(/AND \(capacity_snapshot_stale OR capacity_snapshot_age_ms IS NOT NULL\)/);
    expect(slo).toMatch(/\*\*Unreleased\.\*\*/);
  });
});
