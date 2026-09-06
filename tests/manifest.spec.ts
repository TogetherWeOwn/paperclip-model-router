import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION, ROUTE_KEYS, TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("manifest", () => {
  it("targets stock plugin API v1 and keeps versions aligned", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ id: PLUGIN_ID, apiVersion: PLUGIN_API_VERSION, version: PLUGIN_VERSION });
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares exact compatible-upstream native surfaces", () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([TOOL_NAMES.invoke]);
    expect(manifest.apiRoutes?.map((route) => [route.routeKey, route.path, route.companyResolution])).toEqual([
      [ROUTE_KEYS.invoke, "/invoke", { from: "query", key: "companyId" }],
      [ROUTE_KEYS.invokeIssue, "/issues/:issueId/invoke", { from: "issue", param: "issueId" }],
    ]);
  });

  it("declares durable decision-record storage", () => {
    expect(manifest.database).toEqual({
      namespaceSlug: "model_router",
      migrationsDir: "migrations",
      coreReadTables: [],
    });
    expect(readFileSync(join(root, "migrations/001_decision_records.sql"), "utf8"))
      .toContain("plugin_model_router_4dc1d582dd.decision_records");
  });

  it("requests only the published capabilities it uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agent.tools.register",
      "api.routes.register",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "http.outbound",
      "metrics.write",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]);
  });

  it("carries only provider-neutral company configuration", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "budget",
      "capacityRouting",
      "models",
      "routing",
      "rule0",
      "taskClasses",
      "tiering",
      "upstream",
    ]);
  });
});

describe("network and secret discipline", () => {
  it("uses only ctx.http.fetch for inference networking", () => {
    const sources = [
      "src/worker.ts",
      "src/inference/transport.ts",
      "src/inference/adapters.ts",
      "src/capacity/read.ts",
    ].map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    expect(sources).toContain("input.http.fetch");
    expect(sources).not.toMatch(/from\s+["']node:(?:http|https|net|tls)["']/);
    expect(sources).not.toMatch(/\bglobalThis\.fetch\b|(?<!\.)\bfetch\s*\(/);
    expect(sources).toContain('"Accept-Encoding": "identity"');
  });

  it("contains no credential-shaped literals in active artifacts", () => {
    for (const file of [
      "src/config/schema.ts",
      "src/config/resolve.ts",
      "src/config/secret-ref.ts",
      "src/inference/adapters.ts",
      "src/inference/transport.ts",
      "src/worker.ts",
      "tests/fixtures/company-a.json",
      "tests/fixtures/company-b.json",
    ]) {
      const content = readFileSync(join(root, file), "utf8");
      expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
      expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });
});
