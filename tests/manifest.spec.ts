import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";
import manifest from "../src/manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  paperclipPlugin: { manifest: string; worker: string };
};

describe("manifest", () => {
  it("targets the plugin API version this host implements", () => {
    // PLUGIN_API_VERSION is 1 on this instance. A host that moves to 2 must
    // reject this build rather than load it against a changed protocol.
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(manifest.apiVersion).toBe(1);
  });

  it("keeps the manifest version and the package version in step", () => {
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares entrypoints that match package.json's paperclipPlugin block", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(pkg.paperclipPlugin.worker).toBe("./dist/worker.js");
    expect(pkg.paperclipPlugin.manifest).toBe("./dist/manifest.js");
  });

  it("has a stable, namespaced id", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
  });

  it("requests only capabilities it uses", () => {
    // Least privilege: this plugin reads config and issues, writes its own
    // state, calls one HTTP endpoint, resolves one secret ref, and registers a
    // tool and two routes. It asks for no issue-write or agent-control power.
    expect([...manifest.capabilities].sort()).toEqual([
      "activity.log.write",
      "agent.tools.register",
      "api.routes.register",
      "companies.read",
      "http.outbound",
      "issues.read",
      "metrics.write",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]);
    for (const forbidden of ["issues.update", "issues.create", "agents.invoke", "agents.pause"]) {
      expect(manifest.capabilities).not.toContain(forbidden);
    }
  });

  it("carries a config schema, because every company difference lives there", () => {
    expect(manifest.instanceConfigSchema).toBeTruthy();
    const schema = manifest.instanceConfigSchema as { properties: Record<string, unknown> };
    for (const key of [
      "routing",
      "providers",
      "models",
      "taskClasses",
      "tiering",
      "budget",
      "quotaGate",
      "rule0",
    ]) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });

  it("resolves company access for every declared route", () => {
    for (const route of manifest.apiRoutes ?? []) {
      expect(route.companyResolution).toBeTruthy();
      expect(route.capability).toBe("api.routes.register");
    }
  });
});

describe("no secrets in the repository", () => {
  const files = [
    "src/config/schema.ts",
    "src/config/resolve.ts",
    "src/quota/teamclaude.ts",
    "src/worker.ts",
    "src/manifest.ts",
    "tests/fixtures/company-a.json",
    "tests/fixtures/company-b.json",
  ];

  it("contains no credential-shaped literals", () => {
    // The teamclaude key and the OmniRoute credentials are referenced by name
    // and resolved at runtime. Nothing key-shaped may be committed.
    const patterns = [
      /sk-[a-zA-Z0-9]{16,}/,
      /\bBearer\s+[A-Za-z0-9._-]{16,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bghp_[A-Za-z0-9]{20,}/,
    ];
    for (const file of files) {
      const content = readFileSync(join(root, file), "utf8");
      for (const pattern of patterns) {
        expect(content, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("never stores a resolved secret value in config or state", () => {
    const worker = readFileSync(join(root, "src/worker.ts"), "utf8");
    // The resolved key is passed straight to the quota reader and never written.
    expect(worker).not.toMatch(/state\.set\([^)]*apiKey/);
    expect(worker).toMatch(/ctx\.secrets\.resolve/);
  });
});
