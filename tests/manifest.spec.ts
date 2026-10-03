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
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      TOOL_NAMES.invoke,
      TOOL_NAMES.invokeAsync,
      TOOL_NAMES.invokeResult,
    ]);
    expect(manifest.apiRoutes?.map((route) => [route.routeKey, route.path, route.companyResolution])).toEqual([
      [ROUTE_KEYS.invoke, "/invoke", { from: "query", key: "companyId" }],
      [ROUTE_KEYS.invokeIssue, "/issues/:issueId/invoke", { from: "issue", param: "issueId" }],
      [ROUTE_KEYS.invokeAsync, "/invoke-async", { from: "query", key: "companyId" }],
      [ROUTE_KEYS.invokeResult, "/invoke/:requestId", { from: "query", key: "companyId" }],
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
      // TOG-7160 (port of TOG-930): the model-health catalogue sweep needs
      // to enumerate companies and report health flips on the board.
      "activity.log.write",
      "agent.tools.register",
      "api.routes.register",
      "companies.read",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      // TOG-13372: the agent.run.finished subscription that reaps the router's
      // own run invocations (exit for the TOG-13354 H9 host hunk).
      "events.subscribe",
      "http.outbound",
      "jobs.schedule",
      "metrics.write",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]);
  });

  it("schedules the model-health catalogue sweep", () => {
    // TOG-7160 (port of TOG-930): invocation evidence only touches the
    // routed model, so the sweep is the only thing that notices a model
    // going dark upstream. 15 minutes mirrors the original schedule.
    expect(manifest.jobs?.map((job) => [job.jobKey, job.schedule])).toEqual([
      ["reconcile-async-invocations", "* * * * *"],
      ["model-health-probe", "*/15 * * * *"],
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
  it("routes networking through ctx.http.fetch, confining direct fetch to the async upstream client", () => {
    const transport = readFileSync(join(root, "src/inference/transport.ts"), "utf8");
    const others = [
      "src/worker.ts",
      "src/inference/adapters.ts",
      "src/capacity/read.ts",
    ].map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    const all = `${transport}\n${others}`;

    // The host bridge remains the transport's default path; the sync invoke
    // wiring in worker.ts still hands the transport ctx.http.
    expect(transport).toContain("input.http.fetch");
    expect(others).toContain("http: ctx.http");
    // No file reaches for raw node network primitives.
    expect(all).not.toMatch(/from\s+["']node:(?:http|https|net|tls)["']/);
    // The ONLY sanctioned direct fetch is directFetchHttpClient in transport.ts,
    // used solely by the async background continuation to escape the host's 30s
    // cap. It is reached only for the config-validated upstream.baseUrl.
    expect(transport).toContain("export const directFetchHttpClient");
    expect((transport.match(/globalThis\.fetch/g) ?? []).length).toBe(1);
    // No other inference file may reach for global or bare fetch.
    expect(others).not.toMatch(/\bglobalThis\.fetch\b|(?<!\.)\bfetch\s*\(/);
    expect(all).toContain('"Accept-Encoding": "identity"');
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
      "tests/fixtures/company-c.json",
    ]) {
      const content = readFileSync(join(root, file), "utf8");
      expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
      expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });
});
