/**
 * Roster row contract guard (TOG-14187).
 *
 * Read-only, offline assertion over frozen roster fixtures: every roster row
 * carries its required keys, names an allowlisted model, and — when enabled —
 * is bound to a known lane. An enabled row without a lane binding would serve
 * as an unpinned default outside pacing coverage, which is exactly the gap
 * TOG-13513 found (0/107 agreement expressible: no enabled lane-bound rows
 * for any bridge model).
 *
 * Mirrors the assembler invariants in `assemble-additive-config.mjs` (no
 * retained legacy ids, no enabled model outside pacing lanes) without reading
 * the live catalogue or writing the roster. Disabled rows still need keys and
 * an allowlisted model but may be unlaned: they cannot serve, so they are not
 * defaults.
 */

export interface RosterRow {
  id?: unknown;
  tier?: unknown;
  enabled?: unknown;
  laneId?: unknown;
  [key: string]: unknown;
}

export interface RosterContractInput {
  /** Frozen permitted model ids. Never the live catalogue. */
  allowlist: string[];
  /** Frozen known lane ids. */
  lanes: string[];
  /** Roster `models` slice under test. */
  rows: RosterRow[];
}

export interface RosterRowViolation {
  index: number;
  rowId: string | null;
  code: string;
  detail: string;
}

/** Legacy wrapper the assembler strips; an assembled roster must not retain it. */
const LEGACY_WRAPPER = "cliproxy/";

function violation(index: number, row: RosterRow, code: string, detail: string): RosterRowViolation {
  return { index, rowId: typeof row.id === "string" ? row.id : null, code, detail };
}

/**
 * Check every row against the contract. Returns one entry per breach;
 * empty means the fixture is clean. Pure: no I/O, no catalogue read.
 */
export function checkRosterRowContract(input: RosterContractInput): RosterRowViolation[] {
  const allowlisted = new Set(input.allowlist);
  const knownLanes = new Set(input.lanes);
  const violations: RosterRowViolation[] = [];

  input.rows.forEach((row, index) => {
    const missing =
      typeof row.id !== "string" || row.id.length === 0
        ? "id"
        : typeof row.tier !== "string" || row.tier.length === 0
          ? "tier"
          : typeof row.enabled !== "boolean"
            ? "enabled"
            : null;
    if (missing) {
      violations.push(violation(index, row, `missing-key:${missing}`, `row ${index} has no usable ${missing}`));
      return;
    }
    const id = row.id as string;
    const enabled = row.enabled as boolean;

    if (id.startsWith(LEGACY_WRAPPER)) {
      violations.push(violation(index, row, "legacy-id", `row ${id} retains the legacy wrapper`));
      return;
    }
    if (!allowlisted.has(id)) {
      violations.push(violation(index, row, "not-allowlisted", `row ${id} is not in the frozen allowlist`));
    }

    const laneId = row.laneId;
    if (typeof laneId !== "string" || laneId.length === 0) {
      // The no-unpinned-default rule: only enabled rows can serve, so only
      // they must be lane-bound. Disabled rows may be unlaned.
      if (enabled) {
        violations.push(violation(index, row, "unpinned-row", `enabled row ${id} has no lane binding`));
      }
      return;
    }
    if (!knownLanes.has(laneId)) {
      violations.push(violation(index, row, "unknown-lane", `row ${id} binds to unknown lane ${laneId}`));
    }
  });

  return violations;
}
