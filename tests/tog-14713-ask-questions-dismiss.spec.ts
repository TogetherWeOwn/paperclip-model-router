import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveAskQuestionsOutcome,
  type AskedQuestionFixture,
} from "../src/ask-questions-dismiss.js";

// Flag-gated ask_user_questions dismiss-path parity: the plugin dismiss path
// must resolve exactly like the host dismiss (state cleanup, no dangling
// interaction). Fixtures only, no live mutation.
//
// Fixture mechanics: small in-memory question lists run through the pure verb
// under each disposition. The dismiss-vs-accept matrix proves the two paths
// share the closed interaction but differ on recording; flag-off tests prove
// the legacy open/nothing-recorded shape returns; the import test proves there
// is no live call path to record or close through in the first place.

const QUESTIONS: AskedQuestionFixture[] = [
  { id: "q-model", prompt: "Which model should pace this lane?" },
  { id: "q-window", prompt: "Which weekly window applies?" },
];

describe("ask_user_questions dismiss path matches host (flag on)", () => {
  it("dismiss records nothing and closes the interaction", () => {
    expect(
      resolveAskQuestionsOutcome(QUESTIONS, "dismiss", { enabled: true }),
    ).toEqual({ recordedIds: [], interactionStatus: "closed", reason: "dismissed" });
  });

  it("dismiss on empty questions still closes with nothing recorded", () => {
    expect(resolveAskQuestionsOutcome([], "dismiss", { enabled: true })).toEqual({
      recordedIds: [],
      interactionStatus: "closed",
      reason: "dismissed",
    });
  });
});

describe("ask_user_questions dismiss-vs-accept matrix (flag on)", () => {
  it("accept records one id per question and closes; dismiss closes with none", () => {
    const accept = resolveAskQuestionsOutcome(QUESTIONS, "accept", { enabled: true });
    const dismiss = resolveAskQuestionsOutcome(QUESTIONS, "dismiss", { enabled: true });
    expect(accept).toEqual({
      recordedIds: ["q-model", "q-window"],
      interactionStatus: "closed",
      reason: "accepted",
    });
    expect(dismiss).toEqual({
      recordedIds: [],
      interactionStatus: "closed",
      reason: "dismissed",
    });
    // Parity shape: same closed interaction, recording differs.
    expect(accept.interactionStatus).toBe(dismiss.interactionStatus);
    expect(accept.recordedIds).toHaveLength(QUESTIONS.length);
    expect(dismiss.recordedIds).toHaveLength(0);
  });

  it("accept skips questions without a usable id", () => {
    const out = resolveAskQuestionsOutcome(
      [{ id: "", prompt: "blank" }, { id: "q-third", prompt: "Third" }],
      "accept",
      { enabled: true },
    );
    expect(out).toEqual({
      recordedIds: ["q-third"],
      interactionStatus: "closed",
      reason: "accepted",
    });
  });

  it("unknown disposition records nothing and leaves the interaction open", () => {
    expect(
      resolveAskQuestionsOutcome(QUESTIONS, "snooze", { enabled: true }),
    ).toEqual({ recordedIds: [], interactionStatus: "open", reason: "unknown-disposition" });
  });
});

describe("ask_user_questions flag gating (flag-off restores old behavior)", () => {
  it("flag absent (default off) leaves the interaction open with nothing recorded", () => {
    for (const disposition of ["dismiss", "accept"]) {
      expect(resolveAskQuestionsOutcome(QUESTIONS, disposition)).toEqual({
        recordedIds: [],
        interactionStatus: "open",
        reason: "disabled",
      });
    }
  });

  it("flag explicitly off matches the default-off shape", () => {
    for (const disposition of ["dismiss", "accept"]) {
      expect(
        resolveAskQuestionsOutcome(QUESTIONS, disposition, { enabled: false }),
      ).toEqual(resolveAskQuestionsOutcome(QUESTIONS, disposition));
    }
  });
});

describe("ask_user_questions shadow purity (no live mutation)", () => {
  it("never mutates the input array or its entries", () => {
    const questions: AskedQuestionFixture[] = [
      { id: "q-model", prompt: "Which model should pace this lane?" },
      { id: "q-window", prompt: "Which weekly window applies?" },
    ];
    const snapshot = structuredClone(questions);
    const accept = resolveAskQuestionsOutcome(questions, "accept", { enabled: true });
    const dismiss = resolveAskQuestionsOutcome(questions, "dismiss", { enabled: true });
    expect(questions).toEqual(snapshot);
    expect(accept.recordedIds).not.toBe(questions as unknown);
    expect(dismiss.recordedIds).toEqual([]);
    // Fresh arrays per call: mutating one outcome never touches the next.
    accept.recordedIds.push("mutant");
    expect(
      resolveAskQuestionsOutcome(questions, "accept", { enabled: true }).recordedIds,
    ).toEqual(["q-model", "q-window"]);
  });

  it("the verb module imports no live plugin surface", () => {
    // The verb is pure: it takes fixtures and returns a fresh shadow outcome.
    // If this module ever gains an import reaching the worker, config, plugin
    // SDK, or any state/db/http/secrets/record-creation surface, a live call
    // path exists and this test must fail. Only import lines are inspected, so
    // the doc comment may name the forbidden surfaces without tripping it.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "ask-questions-dismiss.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|respond|interaction|task|record/i);
    // The suite's only sink is the returned shadow outcome: flag-off silence
    // above is silence of the only output the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
