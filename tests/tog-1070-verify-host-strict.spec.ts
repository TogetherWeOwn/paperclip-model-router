/**
 * TOG-1070 — `verify:host` must not be able to pass by not running.
 *
 * The bug: `verify-stock-host-controls.mjs` printed `SKIP stock host control
 * probes` and exited 0 when it could not resolve a tsx loader, so
 * `npm run verify` reported success with a required pre-tag gate never having
 * executed. v0.4.1 and v0.4.2 were both tagged that way. TOG-1064 fixed the
 * proximate cause (a hardcoded `tsx@4.23.1` path); this pins the SHAPE, which
 * that fix left intact — the next thing to stop resolving would have been just
 * as silent.
 *
 * These drive the real scripts as subprocesses rather than unit-testing the
 * policy helper alone. The failure was in the exit code of a script, and only
 * the script produces an exit code — a green policy function is exactly the
 * kind of oracle that agreed with the broken gate all along.
 *
 * Every case redirects the receipt to a temp file: a test run is not evidence
 * of a host gate and must not leave something that looks like it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const STOCK = "scripts/verify-stock-host-controls.mjs";
const MANIFEST = "scripts/verify-against-host.mjs";

let scratch: string;
let receipt: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tog1070-"));
  receipt = join(scratch, "receipt.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  status: number;
  output: string;
}

/**
 * `PAPERCLIP_HOST: undefined` in `env` must actually delete the variable, not
 * pass "undefined" through — the harness that runs this suite may well have one
 * set, and inheriting it would silently turn a permissive case strict.
 */
function run(script: string, env: Record<string, string | undefined>): Run {
  const child = { ...process.env, MODEL_ROUTER_VERIFY_RECEIPT: receipt, ...env };
  for (const [key, value] of Object.entries(child)) {
    if (value === undefined) delete (child as Record<string, unknown>)[key];
  }
  try {
    const output = execFileSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: child as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

/** A host root that exists but holds no Paperclip build — the loader cannot resolve. */
const ABSENT_HOST = "/nonexistent-paperclip-host";

describe("TOG-1070: a skipped host probe cannot report success", () => {
  it("FAILS when a host is requested and the probes cannot run", () => {
    const result = run(STOCK, { PAPERCLIP_HOST: ABSENT_HOST, ALLOW_HOST_PROBE_SKIP: undefined });

    // The exit code is the whole bug. Before this fix it was 0.
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("FAIL  stock host control probes");
    expect(result.output).not.toContain("SKIP  stock host control probes");
  });

  it("still SKIPs, and exits 0, when no host was requested at all", () => {
    // CI has never had a checkout. Failing there would make the gate impossible
    // to satisfy rather than honest, so permissive must survive.
    const result = run(STOCK, { PAPERCLIP_HOST: "", ALLOW_HOST_PROBE_SKIP: undefined });

    // This machine may genuinely have a host at /app, in which case the run is
    // strict and the probes execute. Either outcome is correct; what must never
    // happen is a skip that exits 0 while a host was reachable.
    if (result.output.includes("SKIP  stock host control probes")) {
      expect(result.status).toBe(0);
      expect(result.output).toContain("permissive");
    } else {
      expect(result.status).toBe(0);
      expect(result.output).toContain("probe(s) executed");
    }
  });

  it("honours ALLOW_HOST_PROBE_SKIP as an explicit, recorded opt-out", () => {
    const result = run(STOCK, { PAPERCLIP_HOST: ABSENT_HOST, ALLOW_HOST_PROBE_SKIP: "1" });

    expect(result.status).toBe(0);
    expect(result.output).toContain("SKIP  stock host control probes");

    // The opt-out is only safe because it is written down: the release gate
    // reads this and refuses to quote the run.
    const written = JSON.parse(readFileSync(receipt, "utf8"));
    expect(written.stockControls).toMatchObject({ strict: false, optedOut: true, checksRun: 0 });
  });

  it("FAILS the manifest script when the requested host does not load", () => {
    const result = run(MANIFEST, { PAPERCLIP_HOST: ABSENT_HOST, ALLOW_HOST_PROBE_SKIP: undefined });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("FAIL  the requested host checkout loaded");
    // The per-check diagnostic must survive being upgraded to a failure — the
    // label is the only thing that says WHAT stopped resolving.
    expect(result.output).toContain("install step 4");
  });

  it("records a clean strict run only when checks actually executed", () => {
    const result = run(STOCK, { PAPERCLIP_HOST: ABSENT_HOST, ALLOW_HOST_PROBE_SKIP: "1" });
    expect(result.status).toBe(0);

    const written = JSON.parse(readFileSync(receipt, "utf8"));
    // Zero executed probes must never read as a passing section: this is the
    // property the release gate depends on.
    expect(written.stockControls.checksRun).toBe(0);
    expect(written.stockControls.strict).toBe(false);
  });
});

describe("TOG-1070: the release gate refuses a pin the host gate never covered", () => {
  function pinCheck(env: Record<string, string | undefined> = {}): Run {
    const child = { ...process.env, MODEL_ROUTER_VERIFY_RECEIPT: receipt, ...env };
    for (const [key, value] of Object.entries(child)) {
      if (value === undefined) delete (child as Record<string, unknown>)[key];
    }
    try {
      const output = execFileSync(
        process.execPath,
        ["scripts/release-pin-check.mjs", "--tag", "v0.4.2", "--offline", "--no-build"],
        { cwd: repo, encoding: "utf8", env: child as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, output };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failed.status ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
    }
  }

  it("fails gate 8 when no receipt exists", () => {
    const result = pinCheck();
    expect(result.output).toMatch(/FAIL {2}8 {2}verify:host ran strictly/);
    expect(result.output).toContain("has not been run from this checkout");
  });

  it("fails gate 8 when the receipt describes a different commit", () => {
    run(STOCK, { PAPERCLIP_HOST: ABSENT_HOST, ALLOW_HOST_PROBE_SKIP: "1" });
    const result = pinCheck();

    // v0.4.2 is not HEAD in any working checkout of this branch, so the receipt
    // this test just wrote cannot back it — which is the point of keying the
    // receipt to a commit rather than to a file's existence.
    expect(result.output).toMatch(/FAIL {2}8 {2}verify:host ran strictly/);
  });

  /**
   * The cases above only ever reject a receipt for being ABSENT or for naming
   * the WRONG COMMIT. A gate that checked nothing else would pass all of them,
   * which makes them blind to the defect that actually matters: a receipt for
   * the right commit that records a run proving nothing. Each case below forges
   * a receipt naming the tagged commit and differs in exactly one field.
   */
  const tagCommit = execFileSync("git", ["rev-parse", "v0.4.2^{commit}"], { cwd: repo, encoding: "utf8" }).trim();

  const clean = {
    checksRun: 20,
    failures: 0,
    skipped: 0,
    strict: true,
    optedOut: false,
    hostRoot: "/app",
  };

  function forge(sections: Record<string, unknown>): Run {
    writeFileSync(receipt, JSON.stringify({ version: 1, commit: tagCommit, ...sections }));
    return pinCheck();
  }

  it("ACCEPTS a receipt that records a complete strict run of the tagged commit", () => {
    // The control. Without this, every assertion below would also pass against
    // a gate hardcoded to reject, and the suite would be reject-only — blind to
    // the gate being wrong in the impossible-to-satisfy direction.
    const result = forge({ manifest: clean, stockControls: { ...clean, checksRun: 4 } });
    expect(result.output).toMatch(/PASS {2}8 {2}verify:host ran strictly/);
  });

  it("rejects a receipt whose run was permissive", () => {
    const result = forge({
      manifest: { ...clean, strict: false },
      stockControls: { ...clean, checksRun: 4 },
    });
    expect(result.output).toMatch(/FAIL {2}8 {2}verify:host ran strictly/);
    expect(result.output).toContain("ran permissively");
  });

  it("rejects a receipt that recorded a skipped check", () => {
    const result = forge({
      manifest: clean,
      stockControls: { ...clean, checksRun: 4, skipped: 1 },
    });
    expect(result.output).toMatch(/FAIL {2}8 {2}verify:host ran strictly/);
    expect(result.output).toContain("skipped check(s)");
  });

  it("rejects a receipt missing a section — one script is not the gate", () => {
    const result = forge({ manifest: clean });
    expect(result.output).toMatch(/FAIL {2}8 {2}verify:host ran strictly/);
    expect(result.output).toContain("missing section");
  });

  it("rejects a receipt recording zero executed checks", () => {
    const result = forge({
      manifest: { ...clean, checksRun: 0 },
      stockControls: { ...clean, checksRun: 0 },
    });
    expect(result.output).toMatch(/FAIL {2}8 {2}verify:host ran strictly/);
    expect(result.output).toContain("zero executed checks");
  });
}, 60_000);
