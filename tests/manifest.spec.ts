import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JOB_KEYS, PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION, ROUTE_KEYS, TOOL_NAMES } from "../src/constants.js";
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

  it("requests only the published capabilities it uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      // The health probe's three: it logs flips to the board, runs on the
      // host's own scheduler, and has to enumerate companies because a job is
      // not a company-scoped invocation.
      "activity.log.write",
      "agent.tools.register",
      "api.routes.register",
      "companies.read",
      "http.outbound",
      "jobs.schedule",
      "metrics.write",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]);
  });

  it("holds no capability that could change what model an agent runs on", () => {
    // decisions/0010: the host lets a plugin rewrite an agent's adapterConfig —
    // model, ANTHROPIC_MODEL, ANTHROPIC_BASE_URL — but only through
    // `agents.managed`. The router is an invocation API and does not govern
    // agent model selection, and this is where that stops being a promise.
    // The host pairs these two itself — declaring `agents` without
    // `agents.managed` fails its own manifest validator — so asserting both
    // leaves no way to acquire the authority by halves.
    expect(manifest.capabilities.filter((name) => name.startsWith("agents."))).toEqual([]);
    expect(manifest.agents ?? []).toEqual([]);
  });

  it("declares the model health job the scheduler will run", () => {
    expect(manifest.jobs?.map((job) => [job.jobKey, job.schedule])).toEqual([
      [JOB_KEYS.modelHealth, "*/15 * * * *"],
    ]);
  });

  it("carries only provider-neutral company configuration", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "budget",
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
