import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import { fixtureConfig } from "./helpers.js";

const A = fixtureConfig("company-a");
const B = fixtureConfig("company-b");

describe("one install, isolated company configuration", () => {
  it("selects only from each company's model table", () => {
    const a = selectModel({ descriptor: { taskClass: "implementation" }, config: A });
    const b = selectModel({ descriptor: { taskClass: "implementation" }, config: B });
    expect(a.modelId).toBe("minimax-m2.5");
    expect(b.modelId).toBe("gpt-4.1");
    expect(B.models.some((model) => model.id === a.modelId)).toBe(false);
  });

  it("keeps protocol, URL, secret reference and limits company-scoped", () => {
    expect(A.upstream.protocol).toBe("openai-chat-completions");
    expect(B.upstream.protocol).toBe("anthropic-messages");
    expect(A.upstream.baseUrl).not.toBe(B.upstream.baseUrl);
    expect(A.upstream.credentialSecretRef?.secretId).not.toBe(B.upstream.credentialSecretRef?.secretId);
    expect(A.routing.maxOutputTokens).not.toBe(B.routing.maxOutputTokens);
  });
});
