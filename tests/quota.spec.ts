import { describe, expect, it } from "vitest";

import { classifyHttpError } from "../src/inference/adapters.js";

describe("compatible-upstream HTTP classifications", () => {
  it.each([
    [301, "upstream-redirect", false],
    [401, "upstream-authentication", false],
    [403, "upstream-permission", false],
    [404, "upstream-not-found", false],
    [408, "upstream-timeout", true],
    [409, "upstream-conflict", true],
    [418, "upstream-client-error", false],
    [429, "upstream-rate-limit", true],
    [500, "upstream-server-error", true],
    [529, "upstream-overloaded", true],
    [599, "upstream-server-error", true],
  ] as const)("maps HTTP %s to %s", (status, code, retryable) => {
    expect(classifyHttpError(status, "request-1")).toEqual(expect.objectContaining({ code, retryable, upstreamStatus: status, upstreamRequestId: "request-1" }));
  });
});
