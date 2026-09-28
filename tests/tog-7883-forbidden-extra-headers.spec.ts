/**
 * TOG-7883 (gap G5): a forbidden extraHeaders name must fail closed at
 * config load AND at the wire — never ride an upstream call.
 *
 * The schema declares the list (`propertyNames.not`, form metadata the host
 * may or may not compile) and `validateUpstreamConfig` refuses post-resolve
 * values, but `resolveConfig` used to copy names through unchecked, and
 * `requestHeaders` spread them straight onto the wire. An `Authorization`
 * smuggle would have ridden every upstream call under the resolved
 * credential. Both layers now refuse; removing either refusal goes red.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FORBIDDEN_EXTRA_HEADER_NAMES } from "../src/config/upstream-constraints.js";
import { resolveConfig } from "../src/config/resolve.js";
import { requestHeaders, validateUpstreamConfig } from "../src/inference/adapters.js";
import { invokeCompatibleUpstream } from "../src/inference/transport.js";
import type { InvokeRequest } from "../src/inference/types.js";
import { ACTION_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { fixtureConfig, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";

function rawWithExtraHeader(name: string): Record<string, unknown> {
  const raw = structuredClone(readFixture("company-a")) as Record<string, unknown>;
  (raw.upstream as Record<string, unknown>).extraHeaders = { [name]: "smuggled" };
  return raw;
}

const request: InvokeRequest = {
  task: { taskClass: "implementation" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 10,
};

describe("TOG-7883: forbidden extraHeaders fail closed at resolve time", () => {
  it.each([...FORBIDDEN_EXTRA_HEADER_NAMES])("resolveConfig throws on %s", (name) => {
    expect(() => resolveConfig(rawWithExtraHeader(name))).toThrow(
      `upstream.extraHeaders must not set ${name}`,
    );
  });

  it.each([...FORBIDDEN_EXTRA_HEADER_NAMES])("resolveConfig throws on %s in any case", (name) => {
    const mixed = name
      .split("")
      .map((character, index) => (index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()))
      .join("");
    // Every forbidden name carries alphas, so the alternating mix always
    // differs from the bare name while folding back to it.
    expect(mixed).not.toBe(name);
    expect(mixed.toLowerCase()).toBe(name);
    expect(() => resolveConfig(rawWithExtraHeader(mixed))).toThrow("upstream.extraHeaders must not set");
  });

  it("resolveConfig still accepts a benign header and ignores non-string values", () => {
    const raw = structuredClone(readFixture("company-a")) as Record<string, unknown>;
    (raw.upstream as Record<string, unknown>).extraHeaders = {
      "X-Company-Lane": "a",
      "X-Trace-Id": 7,
    };
    expect(resolveConfig(raw).upstream.extraHeaders).toEqual({ "X-Company-Lane": "a" });
  });

  it("onValidateConfig refuses a smuggled name as ok:false, not a 500", async () => {
    const { definition } = createPlugin();
    const result = await definition.onValidateConfig!(rawWithExtraHeader("Authorization"));
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).join("\n")).toContain("upstream.extraHeaders must not set Authorization");
  });
});

describe("TOG-7883: no request can carry a forbidden name on the wire", () => {
  // The reviewer acceptance triple: the two auth headers plus the body-framing header.
  it.each(["authorization", "x-api-key", "content-type"])("requestHeaders throws on %s in any case", (name) => {
    for (const spelling of [name, name.toUpperCase(), name.replace(/(^|-)([a-z])/g, (match) => match.toUpperCase())]) {
      const config = fixtureConfig("company-a").upstream;
      config.extraHeaders = { [spelling]: "smuggled" };
      expect(() => requestHeaders(config, "resolved-credential")).toThrow(
        "upstream.extraHeaders must not set",
      );
    }
  });

  it("requestHeaders throws on every forbidden name, mixed case", () => {
    for (const name of FORBIDDEN_EXTRA_HEADER_NAMES) {
      const config = fixtureConfig("company-a").upstream;
      config.extraHeaders = { [name.toUpperCase()]: "smuggled" };
      expect(() => requestHeaders(config, "resolved-credential")).toThrow(
        "upstream.extraHeaders must not set",
      );
    }
  });

  it("requestHeaders keeps benign headers and owns the auth/body headers", () => {
    const openai = fixtureConfig("company-a").upstream;
    expect(requestHeaders(openai, "resolved-a")).toEqual({
      "X-Company-Lane": "a",
      Authorization: "Bearer resolved-a",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "identity",
    });
    // Validation and wire agree on the full list.
    const probe = fixtureConfig("company-a").upstream;
    probe.extraHeaders = Object.fromEntries(
      FORBIDDEN_EXTRA_HEADER_NAMES.map((name) => [name, "smuggled"]),
    );
    expect(validateUpstreamConfig(probe).filter((error) => error.includes("extraHeaders"))).toHaveLength(
      FORBIDDEN_EXTRA_HEADER_NAMES.length,
    );
  });

  it("the transport fails closed before HTTP when the wire guard trips", async () => {
    const config = fixtureConfig("company-a").upstream;
    config.extraHeaders = { Authorization: "smuggled" };
    const fetch = vi.fn();
    const result = await invokeCompatibleUpstream({
      http: { fetch },
      config,
      credential: "resolved-credential",
      request,
      modelId: "minimax-m2.5",
    });
    expect(result.error).toMatchObject({ code: "upstream-url-rejected", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("smuggled");
  });
});

describe("TOG-7883: invoke refuses a smuggled config before secrets or HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with upstream-url-rejected and makes zero secret/HTTP calls", async () => {
    const configs = new Map([[COMPANY_A, rawWithExtraHeader("Authorization")]]);
    const harness = createTestHarness({ manifest, config: {} });
    harness.ctx.config = {
      async get(companyId?: string) {
        const config = configs.get(String(companyId));
        if (!config) throw new Error("missing company config");
        return structuredClone(config);
      },
    };
    const secretCalls: unknown[] = [];
    harness.ctx.secrets = {
      async resolve(ref: never, options?: Record<string, unknown>) {
        secretCalls.push({ ref, ...options });
        return "never-resolved";
      },
    };
    const httpCalls: unknown[] = [];
    harness.ctx.http = {
      async fetch(url: unknown, init?: RequestInit) {
        httpCalls.push({ url: String(url), init });
        return new Response("never-sent", { status: 200 });
      },
    };
    vi.stubGlobal("fetch", async () => new Response("never-sent", { status: 200 }));
    const { definition } = createPlugin();
    await definition.setup(harness.ctx);

    const result = (await harness.performAction(
      ACTION_KEYS.invoke,
      {
        task: { taskClass: "implementation", issueId: "issue-1" },
        messages: [{ role: "user", content: "hello" }],
        maxOutputTokens: 100,
      },
      { companyId: COMPANY_A },
    )) as { outcome: string; error: { code: string } };

    expect(result).toMatchObject({ outcome: "error", error: { code: "upstream-url-rejected" } });
    expect(secretCalls).toHaveLength(0);
    expect(httpCalls).toHaveLength(0);
  });
});
