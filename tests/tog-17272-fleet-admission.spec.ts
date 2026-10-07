import { describe, expect, it } from "vitest";

import { laneBurnDown } from "../packages/lane-capacity/src/burn-down.js";
import {
  applyHysteresis,
  proposeFleetAdmission,
  type FleetAdmissionLaneInput,
} from "../packages/lane-capacity/src/fleet-admission.js";
import { evaluateLanePace, normalizeLaneDocument, type LanePaceVerdict } from "../packages/lane-capacity/src/pace.js";

// Fleet admission from total remaining weekly allowance (offline).
//
// Every lane below runs through the real pace evaluator and the real
// burn-down readout from a synthetic lane document — never from hand-typed
// scores. The proposal itself is pure and propose-only: no config read, no
// host call, no selection or cap change.
//
// Scope boundaries (owned elsewhere, not duplicated here):
// - per-lane pace states and the 98-100% band: the pace and burn-down slices;
// - per-decision admit/deny: the policy replay and calibration slices;
// - burn alert levels: the burn-alerts slice;
// - applying the proposal (pacer/admission path, shadow validation): the host.

const WEEK_SECONDS = 604_800;
const FIVE_HOUR_SECONDS = 18_000;
const HOUR_MS = 3_600_000;

interface AccountBurn {
  allowanceUtilization: number;
  fiveHourUtilization?: number;
  weight?: number;
}

function definitionFor(laneId: string, allowanceWindow = "weekly") {
  return {
    laneId,
    healthFields: ["health"],
    windows: [
      { name: "five_hour", role: "serviceability" as const, utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
      { name: allowanceWindow, role: "allowance" as const, utilizationFields: [`${allowanceWindow}_utilization`], resetFields: [`${allowanceWindow}_resets_at`] },
    ],
  };
}

function laneInput(
  laneId: string,
  asOf: string,
  expiry: string,
  accounts: AccountBurn[],
  allowanceWindow = "weekly",
): FleetAdmissionLaneInput {
  const document = {
    schemaVersion: 1,
    observedAt: asOf,
    staleAfterSeconds: 7200,
    records: accounts.map((account) => ({
      health: "healthy",
      weight: account.weight ?? 1,
      governing_window: allowanceWindow,
      window_seconds: { five_hour: FIVE_HOUR_SECONDS, [allowanceWindow]: WEEK_SECONDS },
      five_hour_utilization: account.fiveHourUtilization ?? 0.1,
      five_hour_resets_at: new Date(Date.parse(asOf) + 3 * HOUR_MS).toISOString(),
      [`${allowanceWindow}_utilization`]: account.allowanceUtilization,
      [`${allowanceWindow}_resets_at`]: expiry,
    })),
  };
  const verdict: LanePaceVerdict = evaluateLanePace({
    observation: normalizeLaneDocument({ document, definition: definitionFor(laneId, allowanceWindow) }),
    asOf,
  });
  return { verdict, burndown: laneBurnDown(verdict), windowSeconds: WEEK_SECONDS };
}

/** Half-week mark: elapsed = 0.5, so projected = 2 × utilization. */
const EXPIRY = "2026-09-17T14:53:41.507882Z";
const HALFWAY = new Date(Date.parse(EXPIRY) - 84 * HOUR_MS).toISOString();

describe("fleet admission from total remaining weekly allowance (offline)", () => {
  it("boosts an under-used fleet so allowance is spent before reset", () => {
    const proposal = proposeFleetAdmission({
      lanes: [
        laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }]),
        laneInput("codex", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.4 }]),
      ],
      asOf: HALFWAY,
    });
    expect(proposal.level).toBe("boost");
    expect(proposal.reason).toBe("fleet-under-use-boost");
    expect(proposal.admissionFraction).toBe(1.25);
    // Fleet projected is the weight-weighted mean: (0.6 + 0.8) / 2 = 0.7.
    expect(proposal.projected).toBeCloseTo(0.7, 5);
    // Fleet remaining is the weight-weighted mean: (0.7 + 0.6) / 2 = 0.65.
    expect(proposal.remainingFraction).toBeCloseTo(0.65, 5);
    expect(proposal.withheld).toEqual([]);
    expect(proposal.spendOrder).toHaveLength(2);
  });

  it("holds steady on an on-track fleet", () => {
    const proposal = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.495 }])],
      asOf: HALFWAY,
    });
    expect(proposal.level).toBe("normal");
    expect(proposal.reason).toBe("fleet-on-track");
    expect(proposal.admissionFraction).toBe(1.0);
  });

  it("throttles an over-burning fleet, harder when hotter", () => {
    const hold = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.6 }])],
      asOf: HALFWAY,
    });
    expect(hold.projected).toBeCloseTo(1.2, 5);
    expect(hold.level).toBe("hold");
    expect(hold.admissionFraction).toBe(0.6);

    const conserve = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.9 }])],
      asOf: HALFWAY,
    });
    expect(conserve.projected).toBeCloseTo(1.8, 5);
    expect(conserve.level).toBe("conserve");
    expect(conserve.admissionFraction).toBe(0.25);
  });

  it("spends the soonest-reset lane first, headroom breaking reset ties", () => {
    const sooner = new Date(Date.parse(EXPIRY) - 24 * HOUR_MS).toISOString();
    const proposal = proposeFleetAdmission({
      lanes: [
        // Hotter burn but nearer reset: spent first.
        laneInput("codex", sooner, EXPIRY, [{ allowanceUtilization: 0.8 }]),
        // Cooler burn but later reset: spent second.
        laneInput("muse", sooner, "2026-09-20T14:53:41.507882Z", [{ allowanceUtilization: 0.2 }]),
      ],
      asOf: sooner,
    });
    expect(proposal.spendOrder).toEqual(["codex", "muse"]);

    // Same reset: the lane with more headroom (lower projection) goes first.
    const tied = proposeFleetAdmission({
      lanes: [
        laneInput("codex", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.6 }]),
        laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
      ],
      asOf: HALFWAY,
    });
    expect(tied.spendOrder).toEqual(["muse", "codex"]);
  });

  it("withholds a tripped lane and caps the fleet at hold once half the fleet sits behind trips", () => {
    const proposal = proposeFleetAdmission({
      lanes: [
        laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }]),
        laneInput("codex", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3, fiveHourUtilization: 0.95 }]),
      ],
      asOf: HALFWAY,
    });
    // The weekly picture alone would boost; the five-hour backstop caps it.
    expect(proposal.level).toBe("hold");
    expect(proposal.reason).toBe("capped-by-serviceability-backstop");
    expect(proposal.backstop).toEqual({ trippedLanes: ["codex"], trippedShare: 0.5, holdShare: 0.5, capped: true });
    expect(proposal.withheld).toEqual(["codex"]);
    expect(proposal.spendOrder).toEqual(["muse"]);
  });

  it("does not throttle healthy lanes for a minority trip: the weekly level stands", () => {
    // Four lanes at 0.2 utilization (fleet projected 0.4, well under target),
    // one of them over its five-hour limit. Its weekly allowance is withheld
    // from the spend order; the other three must keep boosting.
    const lanes = [
      laneInput("a", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, fiveHourUtilization: 0.95 }]),
      laneInput("b", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
      laneInput("c", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
      laneInput("d", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
    ];
    const proposal = proposeFleetAdmission({ lanes, asOf: HALFWAY });
    expect(lanes[0]!.verdict.reason).toBe("serviceability-window-exhausted");
    expect(proposal.projected).toBeCloseTo(0.4, 5);
    expect(proposal.level).toBe("boost");
    expect(proposal.reason).toBe("fleet-under-use-boost");
    expect(proposal.admissionFraction).toBe(1.25);
    expect(proposal.backstop.trippedLanes).toEqual(["a"]);
    expect(proposal.backstop.trippedShare).toBeCloseTo(0.25, 5);
    expect(proposal.backstop.capped).toBe(false);
    // The tripped lane is still never spent.
    expect(proposal.withheld).toEqual(["a"]);
    expect(proposal.spendOrder).toEqual(["b", "c", "d"]);
  });

  it("sizes the backstop by tripped weight, so one heavy lane can cap a light fleet", () => {
    const proposal = proposeFleetAdmission({
      lanes: [
        laneInput("heavy", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, fiveHourUtilization: 0.95, weight: 6 }]),
        laneInput("light1", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, weight: 1 }]),
        laneInput("light2", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, weight: 1 }]),
      ],
      asOf: HALFWAY,
    });
    // 6 of 8 weight units sit behind the trip.
    expect(proposal.backstop.trippedShare).toBeCloseTo(0.75, 5);
    expect(proposal.level).toBe("hold");
    expect(proposal.reason).toBe("capped-by-serviceability-backstop");
  });

  it("lets policy restore the any-trip hold or disable the cap", () => {
    const lanes = [
      laneInput("a", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, fiveHourUtilization: 0.95 }]),
      laneInput("b", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
      laneInput("c", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
      laneInput("d", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2 }]),
    ];
    const anyTrip = proposeFleetAdmission({ lanes, asOf: HALFWAY, policy: { backstopHoldShare: 0 } });
    expect(anyTrip.level).toBe("hold");
    expect(anyTrip.backstop.capped).toBe(true);

    const allSides = [
      laneInput("a", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, fiveHourUtilization: 0.95 }]),
      laneInput("b", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.2, fiveHourUtilization: 0.95 }]),
    ];
    const disabled = proposeFleetAdmission({ lanes: allSides, asOf: HALFWAY, policy: { backstopHoldShare: 2 } });
    expect(disabled.backstop.trippedShare).toBe(1);
    expect(disabled.backstop.capped).toBe(false);
  });

  it("never lowers a level the weekly picture already restricts", () => {
    const proposal = proposeFleetAdmission({
      lanes: [
        laneInput("a", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.9, fiveHourUtilization: 0.95 }]),
        laneInput("b", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.9 }]),
      ],
      asOf: HALFWAY,
    });
    // Half the fleet is tripped, but weekly alone already says conserve.
    expect(proposal.level).toBe("conserve");
    expect(proposal.reason).toBe("fleet-over-burn-conserve");
    expect(proposal.backstop.capped).toBe(false);
  });

  describe("without an explicit asOf", () => {
    const unavailable = (): FleetAdmissionLaneInput => {
      const verdict: LanePaceVerdict = evaluateLanePace({
        observation: normalizeLaneDocument({ document: null, definition: definitionFor("gone") }),
        asOf: HALFWAY,
      });
      expect(verdict.reason).toBe("document-unavailable");
      expect(verdict.observedAt).toBeNull();
      return { verdict, burndown: laneBurnDown(verdict), windowSeconds: WEEK_SECONDS };
    };

    it("is independent of lane order and keeps the spend order when the first lane is unavailable", () => {
      const healthy = () => [
        laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }]),
        laneInput("codex", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.4 }]),
      ];
      const gonePrefix = proposeFleetAdmission({ lanes: [unavailable(), ...healthy()] });
      const goneSuffix = proposeFleetAdmission({ lanes: [...healthy(), unavailable()] });
      expect(gonePrefix.asOf).toBe(HALFWAY);
      expect(gonePrefix.spendOrder).toEqual(["muse", "codex"]);
      expect(gonePrefix.withheld).toEqual(["gone"]);
      expect(gonePrefix.lanes.filter((lane) => lane.laneId !== "gone").every((lane) => lane.hoursToReset !== null)).toBe(true);
      // Same lanes, different order: same proposal up to lane listing order.
      expect(goneSuffix.asOf).toBe(gonePrefix.asOf);
      expect(goneSuffix.level).toBe(gonePrefix.level);
      expect(goneSuffix.spendOrder).toEqual(gonePrefix.spendOrder);
      expect(goneSuffix.soonestResetAt).toBe(gonePrefix.soonestResetAt);
    });

    it("uses the latest observation, so a stale first lane does not shift hours-to-reset", () => {
      const staleAt = new Date(Date.parse(HALFWAY) - 5 * HOUR_MS).toISOString();
      // The first lane's snapshot is five hours older than the second's. The
      // old fallback took the first lane's time as the fleet clock, which
      // shifted every other lane's hours-to-reset by that age (84 → 89).
      const stale = laneInput("stale", staleAt, EXPIRY, [{ allowanceUtilization: 0.3 }]);
      const fresh = laneInput("fresh", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }]);
      const derived = proposeFleetAdmission({ lanes: [stale, fresh] });
      const explicit = proposeFleetAdmission({ lanes: [stale, fresh], asOf: HALFWAY });
      expect(derived.asOf).toBe(HALFWAY);
      expect(derived.lanes.find((lane) => lane.laneId === "fresh")?.hoursToReset).toBeCloseTo(84, 5);
      expect(derived.lanes.map((lane) => lane.hoursToReset)).toEqual(explicit.lanes.map((lane) => lane.hoursToReset));
    });

    it("builds the spend order even when no clock can be derived", () => {
      // Real verdict with only its observation time cleared: the spend order
      // compares reset times, so it must survive a missing fleet clock.
      const lane = laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }]);
      const proposal = proposeFleetAdmission({
        lanes: [{ ...lane, verdict: { ...lane.verdict, observedAt: null } }],
        asOf: "not-a-time",
      });
      expect(proposal.asOf).toBeNull();
      expect(proposal.spendOrder).toEqual(["muse"]);
      expect(proposal.soonestResetAt).toBe(new Date(EXPIRY).toISOString());
      // Rates need the clock; the level and order do not.
      expect(proposal.lanes[0]!.hoursToReset).toBeNull();
      expect(proposal.lanes[0]!.targetRatePerHour).toBeNull();
    });
  });

  it("reflects an added or cancelled subscription within one evaluation, config untouched", () => {
    const one = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }])],
      asOf: HALFWAY,
    });
    const two = proposeFleetAdmission({
      lanes: [
        laneInput("muse", HALFWAY, EXPIRY, [
          { allowanceUtilization: 0.3 },
          { allowanceUtilization: 0.9 },
        ]),
      ],
      asOf: HALFWAY,
    });
    // Same lane definition, same call shape — only the live document changed.
    expect(one.inventory.knownAccountCount).toBe(1);
    expect(two.inventory.knownAccountCount).toBe(2);
    expect(two.inventory.computableAccountCount).toBe(2);
    // The hot new account drags the fleet mean from boost into hold.
    expect(one.level).toBe("boost");
    expect(two.projected).toBeCloseTo((0.6 + 1.8) / 2, 5);
    expect(two.level).toBe("hold");
  });

  it("reports per-lane pace targets: remaining-per-hour against window-average burn", () => {
    const proposal = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }])],
      asOf: HALFWAY,
    });
    const lane = proposal.lanes[0]!;
    expect(lane.hoursToReset).toBeCloseTo(84, 5);
    // (0.98 - 0.30) / 84 to land exactly on the band edge.
    expect(lane.targetRatePerHour).toBeCloseTo(0.68 / 84, 5);
    // 0.30 burned over 84 elapsed hours.
    expect(lane.windowRatePerHour).toBeCloseTo(0.3 / 84, 5);
    // Behind pace: the target rate exceeds the rate so far — spend faster.
    expect(lane.targetRatePerHour!).toBeGreaterThan(lane.windowRatePerHour!);
  });

  it("stays unknown and fail-neutral when no lane is computable", () => {
    const empty = {
      schemaVersion: 1,
      observedAt: HALFWAY,
      staleAfterSeconds: 7200,
      records: [],
    };
    const verdict: LanePaceVerdict = evaluateLanePace({
      observation: normalizeLaneDocument({ document: empty, definition: definitionFor("muse") }),
      asOf: HALFWAY,
    });
    expect(verdict.reason).toBe("no-records");
    const proposal = proposeFleetAdmission({
      lanes: [{ verdict, burndown: laneBurnDown(verdict), windowSeconds: WEEK_SECONDS }],
      asOf: HALFWAY,
    });
    expect(proposal.level).toBe("unknown");
    expect(proposal.admissionFraction).toBeNull();
    expect(proposal.projected).toBeNull();
    expect(proposal.spendOrder).toEqual([]);
    expect(proposal.withheld).toEqual(["muse"]);
  });

  it("never mutates its inputs", () => {
    const lanes = [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.3 }])];
    const frozen = structuredClone(lanes);
    proposeFleetAdmission({ lanes, asOf: HALFWAY });
    expect(lanes).toEqual(frozen);
  });
});

describe("fleet admission hysteresis (upgrade-only deadband)", () => {
  const base = { boostBelow: 0.98, holdAt: 1.0, conserveAt: 1.5, hysteresis: 0.05 };

  it("downgrades immediately at the boundary", () => {
    expect(applyHysteresis({ ...base, raw: "conserve", previous: "normal", projected: 1.6 })).toBe("conserve");
    expect(applyHysteresis({ ...base, raw: "hold", previous: "boost", projected: 1.05 })).toBe("hold");
  });

  it("holds a restrictive level until the projection clears the deadband", () => {
    // 1.46 reads "hold" raw but sits inside the conserve exit margin (1.45).
    expect(applyHysteresis({ ...base, raw: "hold", previous: "conserve", projected: 1.46 })).toBe("conserve");
    expect(applyHysteresis({ ...base, raw: "hold", previous: "conserve", projected: 1.2 })).toBe("hold");
    // Normal raw, but still inside the hold exit margin (0.95).
    expect(applyHysteresis({ ...base, raw: "normal", previous: "hold", projected: 0.97 })).toBe("hold");
    expect(applyHysteresis({ ...base, raw: "normal", previous: "hold", projected: 0.9 })).toBe("normal");
  });

  it("adopts the raw level with no previous level to defend", () => {
    expect(applyHysteresis({ ...base, raw: "boost", previous: null, projected: 0.5 })).toBe("boost");
    expect(applyHysteresis({ ...base, raw: "hold", previous: "unknown", projected: 1.2 })).toBe("hold");
  });

  it("carries hysteresis through the proposal across cycles", () => {
    const hot = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.9 }])],
      asOf: HALFWAY,
    });
    expect(hot.level).toBe("conserve");
    const cooling = proposeFleetAdmission({
      lanes: [laneInput("muse", HALFWAY, EXPIRY, [{ allowanceUtilization: 0.73 }])],
      asOf: HALFWAY,
      previousLevel: hot.level,
    });
    // Projected 1.46: raw hold, but the conserve deadband holds.
    expect(cooling.projected).toBeCloseTo(1.46, 5);
    expect(cooling.level).toBe("conserve");
  });
});
