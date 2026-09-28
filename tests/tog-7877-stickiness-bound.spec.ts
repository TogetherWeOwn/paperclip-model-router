import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, ISSUE_STICKINESS_MAX_ENTRIES, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

// TOG-7877 (G15): the issue-stickiness row (`issue-stickiness` company state)
// grew one entry per issue id forever. The write path now enforces
// ISSUE_STICKINESS_MAX_ENTRIES as an insertion-ordered LRU: the written
// issue moves to most-recent, the oldest entries past the cap are dropped,
// and non-string junk from a malformed row is pruned instead of holding a
// slot. Reads never move recency, so the sticky hot path (same issue, same
// model) performs no state write. An evicted issue is not an error — its
// next invocation simply re-selects.
//
// Deleting the eviction loop, the rewrite-on-write rebuild, the junk filter,
// or the same-value early return in worker.ts must fail THESE tests — a
// pure-engine test cannot prove the worker wiring.

const COMPANY = "11111111-1111-4111-8111-111111111111";
// The deterministic winner for taskClass "implementation" on the company-a
// fixture (no signals -> default standard tier; only minimax-m2.5 clears the
// quality floor inside the ceiling), so every fresh issue sticks this id.
const STICKY_MODEL = "minimax-m2.5";

function upstreamOk() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion", model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function stickyHarness() {
  const config = readFixture("company-a") as Record<string, unknown>;
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "resolved-secret-a"; } };
  harness.ctx.http = { async fetch() { return upstreamOk(); } };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return harness;
}

type Harness = Awaited<ReturnType<typeof stickyHarness>>;

const requestFor = (issueId: string, taskClass = "implementation") => ({
  task: { taskClass, issueId },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
});

function stickyRow(harness: Harness): Record<string, unknown> {
  return (harness.getState({
    scopeKind: "company",
    scopeId: COMPANY,
    stateKey: STATE_KEYS.issueStickiness,
  }) ?? {}) as Record<string, unknown>;
}

async function seedSticky(harness: Harness, count: number, prefix = "issue"): Promise<void> {
  const seed: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) seed[`${prefix}-${index}`] = STICKY_MODEL;
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.issueStickiness },
    seed,
  );
}

describe("TOG-7877: the issue-stickiness map stays bounded", () => {
  it(`stays under the documented cap (${ISSUE_STICKINESS_MAX_ENTRIES}) when 10k sticky entries are written`, async () => {
    const harness = await stickyHarness();
    await seedSticky(harness, 10_000);

    const result = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-10000"), { companyId: COMPANY },
    ) as { outcome: string };
    expect(result).toMatchObject({ outcome: "completed" });

    const row = stickyRow(harness);
    expect(Object.keys(row)).toHaveLength(ISSUE_STICKINESS_MAX_ENTRIES);
    // The fresh issue is sticky; the 999 most recent seeds survive it.
    expect(row["issue-10000"]).toBe(STICKY_MODEL);
    expect(row["issue-9999"]).toBe(STICKY_MODEL);
    expect(row["issue-9001"]).toBe(STICKY_MODEL);
    // Everything older was evicted oldest-first.
    expect(row["issue-9000"]).toBeUndefined();
    expect(row["issue-0"]).toBeUndefined();
  });

  it("evicts oldest-first and keeps recent issues sticky", async () => {
    const harness = await stickyHarness();
    await seedSticky(harness, ISSUE_STICKINESS_MAX_ENTRIES);

    await harness.performAction(ACTION_KEYS.invoke, requestFor("issue-1000"), { companyId: COMPANY });

    const row = stickyRow(harness);
    expect(Object.keys(row)).toHaveLength(ISSUE_STICKINESS_MAX_ENTRIES);
    expect(row["issue-0"]).toBeUndefined();
    expect(row["issue-1"]).toBe(STICKY_MODEL);
    expect(row["issue-999"]).toBe(STICKY_MODEL);
    expect(row["issue-1000"]).toBe(STICKY_MODEL);
  });

  it("a rewrite refreshes recency instead of growing the row", async () => {
    const harness = await stickyHarness();
    await seedSticky(harness, ISSUE_STICKINESS_MAX_ENTRIES);
    // Plant a stale value on the oldest entry so the next invoke rewrites it.
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.issueStickiness },
      { ...stickyRow(harness), "issue-0": "qwen3-coder" },
    );

    // Rewriting issue-0 moves it to most-recent without evicting anything.
    await harness.performAction(ACTION_KEYS.invoke, requestFor("issue-0"), { companyId: COMPANY });
    let row = stickyRow(harness);
    expect(Object.keys(row)).toHaveLength(ISSUE_STICKINESS_MAX_ENTRIES);
    expect(row["issue-0"]).toBe(STICKY_MODEL);
    expect(row["issue-1"]).toBe(STICKY_MODEL);

    // The next fresh issue evicts issue-1 (now oldest), not the refreshed issue-0.
    await harness.performAction(ACTION_KEYS.invoke, requestFor("issue-1000"), { companyId: COMPANY });
    row = stickyRow(harness);
    expect(Object.keys(row)).toHaveLength(ISSUE_STICKINESS_MAX_ENTRIES);
    expect(row["issue-0"]).toBe(STICKY_MODEL);
    expect(row["issue-1"]).toBeUndefined();
    expect(row["issue-1000"]).toBe(STICKY_MODEL);
  });

  it("the write path itself bounds growth under synthetic load", async () => {
    const harness = await stickyHarness();
    const total = ISSUE_STICKINESS_MAX_ENTRIES + 200;
    for (let index = 0; index < total; index += 1) {
      const result = await harness.performAction(
        ACTION_KEYS.invoke, requestFor(`load-${index}`), { companyId: COMPANY },
      ) as { outcome: string };
      expect(result).toMatchObject({ outcome: "completed" });
    }

    const row = stickyRow(harness);
    expect(Object.keys(row)).toHaveLength(ISSUE_STICKINESS_MAX_ENTRIES);
    expect(row["load-0"]).toBeUndefined();
    expect(row[`load-${total - 1}`]).toBe(STICKY_MODEL);
  });

  it("prunes non-string junk instead of letting it hold a slot", async () => {
    const harness = await stickyHarness();
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.issueStickiness },
      { keep: STICKY_MODEL, junk: 42, nothing: null, nested: { model: STICKY_MODEL } },
    );

    await harness.performAction(ACTION_KEYS.invoke, requestFor("fresh"), { companyId: COMPANY });

    expect(stickyRow(harness)).toEqual({ keep: STICKY_MODEL, fresh: STICKY_MODEL });
  });

  it("same issue, same model performs no stickiness write", async () => {
    const harness = await stickyHarness();
    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    const stickySets: unknown[] = [];
    harness.ctx.state.set = async (key, value) => {
      if ((key as { stateKey?: string }).stateKey === STATE_KEYS.issueStickiness) stickySets.push(value);
      return originalSet(key, value);
    };

    await harness.performAction(ACTION_KEYS.invoke, requestFor("repeat"), { companyId: COMPANY });
    // The first invoke proves the spy sees the write path.
    expect(stickySets).toHaveLength(1);
    expect(stickyRow(harness)).toEqual({ repeat: STICKY_MODEL });

    await harness.performAction(ACTION_KEYS.invoke, requestFor("repeat"), { companyId: COMPANY });
    expect(stickySets).toHaveLength(1);
  });

  it("evicted issues re-select fresh while resident issues stay sticky", async () => {
    const harness = await stickyHarness();
    // taskClass "architecture" (floor 85) selects claude-sonnet-5; the
    // implementation class below would freshly select minimax-m2.5.
    const selected = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("sticky-issue", "architecture"), { companyId: COMPANY },
    ) as { outcome: string; decision: { modelId: string } };
    expect(selected).toMatchObject({ outcome: "completed", decision: { modelId: "claude-sonnet-5" } });
    expect(stickyRow(harness)).toEqual({ "sticky-issue": "claude-sonnet-5" });

    // A full row with the sticky issue as the oldest entry: one more write
    // evicts exactly it.
    const full: Record<string, string> = { "sticky-issue": "claude-sonnet-5" };
    for (let index = 0; index < ISSUE_STICKINESS_MAX_ENTRIES - 1; index += 1) {
      full[`filler-${index}`] = STICKY_MODEL;
    }
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.issueStickiness },
      full,
    );
    await harness.performAction(ACTION_KEYS.invoke, requestFor("held-issue", "architecture"), { companyId: COMPANY });
    let row = stickyRow(harness);
    expect(Object.keys(row)).toHaveLength(ISSUE_STICKINESS_MAX_ENTRIES);
    expect(row["sticky-issue"]).toBeUndefined();
    expect(row["held-issue"]).toBe("claude-sonnet-5");

    // Eviction is not an error: the evicted issue re-selects fresh.
    const evicted = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("sticky-issue"), { companyId: COMPANY },
    ) as { outcome: string; decision: { modelId: string } };
    expect(evicted).toMatchObject({ outcome: "completed", decision: { modelId: STICKY_MODEL } });

    // Control: the resident issue keeps its incumbent even though fresh
    // selection for the same class picks another model.
    row = stickyRow(harness);
    expect(row["held-issue"]).toBe("claude-sonnet-5");
    const held = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("held-issue"), { companyId: COMPANY },
    ) as { outcome: string; decision: { modelId: string } };
    expect(held).toMatchObject({ outcome: "completed", decision: { modelId: "claude-sonnet-5" } });
  });
});
