import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveSuggestTasksOutcome,
  type SuggestedTaskFixture,
} from "../src/suggest-tasks-dismiss.js";

// Flag-gated suggest_tasks dismiss-path parity: the plugin dismiss path must
// match host behavior (no task created, interaction closed). Fixtures only, no
// live mutation.
//
// Fixture mechanics: small in-memory suggestion lists run through the pure
// verb under each disposition. The dismiss-vs-accept matrix proves the two
// paths share the closed interaction but differ on creation; flag-off tests
// prove the legacy open/no-create shape returns; the import test proves there
// is no live call path to create or close through in the first place.

const SUGGESTIONS: SuggestedTaskFixture[] = [
  { id: "task-a", title: "Follow up on capacity" },
  { id: "task-b", title: "Re-check lane health" },
];

describe("suggest-tasks dismiss path matches host (flag on)", () => {
  it("dismiss creates nothing and closes the interaction", () => {
    expect(
      resolveSuggestTasksOutcome(SUGGESTIONS, "dismiss", { enabled: true }),
    ).toEqual({ createdIds: [], interactionStatus: "closed", reason: "dismissed" });
  });

  it("dismiss on empty suggestions still closes with nothing created", () => {
    expect(resolveSuggestTasksOutcome([], "dismiss", { enabled: true })).toEqual({
      createdIds: [],
      interactionStatus: "closed",
      reason: "dismissed",
    });
  });
});

describe("suggest-tasks dismiss-vs-accept matrix (flag on)", () => {
  it("accept creates one id per suggestion and closes; dismiss closes with none", () => {
    const accept = resolveSuggestTasksOutcome(SUGGESTIONS, "accept", { enabled: true });
    const dismiss = resolveSuggestTasksOutcome(SUGGESTIONS, "dismiss", { enabled: true });
    expect(accept).toEqual({
      createdIds: ["task-a", "task-b"],
      interactionStatus: "closed",
      reason: "accepted",
    });
    expect(dismiss).toEqual({
      createdIds: [],
      interactionStatus: "closed",
      reason: "dismissed",
    });
    // Parity shape: same closed interaction, creation differs.
    expect(accept.interactionStatus).toBe(dismiss.interactionStatus);
    expect(accept.createdIds).toHaveLength(SUGGESTIONS.length);
    expect(dismiss.createdIds).toHaveLength(0);
  });

  it("accept skips suggestions without a usable id", () => {
    const out = resolveSuggestTasksOutcome(
      [{ id: "", title: "blank" }, { id: "task-c", title: "Third" }],
      "accept",
      { enabled: true },
    );
    expect(out).toEqual({
      createdIds: ["task-c"],
      interactionStatus: "closed",
      reason: "accepted",
    });
  });

  it("unknown disposition creates nothing and leaves the interaction open", () => {
    expect(
      resolveSuggestTasksOutcome(SUGGESTIONS, "snooze", { enabled: true }),
    ).toEqual({ createdIds: [], interactionStatus: "open", reason: "unknown-disposition" });
  });
});

describe("suggest-tasks flag gating (flag-off restores old behavior)", () => {
  it("flag absent (default off) leaves the interaction open with nothing created", () => {
    for (const disposition of ["dismiss", "accept"]) {
      expect(resolveSuggestTasksOutcome(SUGGESTIONS, disposition)).toEqual({
        createdIds: [],
        interactionStatus: "open",
        reason: "disabled",
      });
    }
  });

  it("flag explicitly off matches the default-off shape", () => {
    for (const disposition of ["dismiss", "accept"]) {
      expect(
        resolveSuggestTasksOutcome(SUGGESTIONS, disposition, { enabled: false }),
      ).toEqual(resolveSuggestTasksOutcome(SUGGESTIONS, disposition));
    }
  });
});

describe("suggest-tasks shadow purity (no live mutation)", () => {
  it("never mutates the input array or its entries", () => {
    const suggestions: SuggestedTaskFixture[] = [
      { id: "task-a", title: "Follow up on capacity" },
      { id: "task-b", title: "Re-check lane health" },
    ];
    const snapshot = structuredClone(suggestions);
    const accept = resolveSuggestTasksOutcome(suggestions, "accept", { enabled: true });
    const dismiss = resolveSuggestTasksOutcome(suggestions, "dismiss", { enabled: true });
    expect(suggestions).toEqual(snapshot);
    expect(accept.createdIds).not.toBe(suggestions as unknown);
    expect(dismiss.createdIds).toEqual([]);
    // Fresh arrays per call: mutating one outcome never touches the next.
    accept.createdIds.push("mutant");
    expect(
      resolveSuggestTasksOutcome(suggestions, "accept", { enabled: true }).createdIds,
    ).toEqual(["task-a", "task-b"]);
  });

  it("the verb module imports no live plugin surface", () => {
    // The verb is pure: it takes fixtures and returns a fresh shadow outcome.
    // If this module ever gains an import reaching the worker, config, plugin
    // SDK, or any state/db/http/secrets/task-creation surface, a live call
    // path exists and this test must fail. Only import lines are inspected, so
    // the doc comment may name the forbidden surfaces without tripping it.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "suggest-tasks-dismiss.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|respond|interaction|task/i);
    // The suite's only sink is the returned shadow outcome: flag-off silence
    // above is silence of the only output the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
