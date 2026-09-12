/**
 * Shared policy for the two `verify:host` scripts: when is a SKIP allowed to
 * pass, and what evidence does a release need that the probes actually ran.
 *
 * TOG-1070. `verify:host` printed `SKIP stock host control probes` and exited
 * 0, so `npm run verify` reported success with a required release gate never
 * having executed. v0.4.1 and v0.4.2 were both tagged that way. The underlying
 * cause (a hardcoded `tsx@4.23.1` path) was fixed in TOG-1064, but the SHAPE
 * survived it: a gate that can pass by absence is indistinguishable from a gate
 * that passed, so the next thing that stops resolving is silent all over again.
 *
 * The rule here is about INTENT, not availability:
 *
 *   - A host checkout is reachable (PAPERCLIP_HOST is set, or one is sitting at
 *     /app) => you asked for the host checks. A check that then fails to run is
 *     a FAILURE. This is the `docs/PROCESS.md` pre-tag invocation.
 *   - No host anywhere => CI, where a checkout has never existed. The mirror
 *     fallbacks are the designed behaviour and SKIP is honest. The run is still
 *     marked as not-host-verified, so it cannot be mistaken for the real gate.
 *
 * `ALLOW_HOST_PROBE_SKIP=1` downgrades strict back to permissive. It is for a
 * host checkout that is knowingly half-built, and it is recorded in the receipt
 * so a release can refuse to quote it.
 *
 * Two kinds of SKIP are NOT the same thing, and collapsing them is how a strict
 * mode becomes a lie the other way:
 *
 *   skip()           the check could have run here and didn't. Strict => FAIL.
 *   skipUnrunnable() the check needs something a build does not have and never
 *                    will — a live instance with a database. Never a failure,
 *                    because no amount of fixing this checkout produces it.
 *
 * Only `skip()` is the TOG-1070 failure shape. `skipUnrunnable()` exists so the
 * page-route-collision check can stay honestly un-run without either lying that
 * it passed or making the gate impossible to satisfy.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where a strict run records what it proved. Git-ignored; it is evidence, not
 * source.
 *
 * `MODEL_ROUTER_VERIFY_RECEIPT` redirects it so the test suite can drive these
 * scripts without overwriting the real receipt — a test run is not evidence of
 * a host gate, and must not be able to leave something that looks like it.
 */
export function receiptPath(env = process.env) {
  return env.MODEL_ROUTER_VERIFY_RECEIPT || join(repoRoot, ".verify-host-receipt.json");
}

export const SKIP_OPT_OUT = "ALLOW_HOST_PROBE_SKIP";

/**
 * Is a Paperclip checkout reachable, and did the caller point at it on purpose?
 *
 * Mirrors `loadHostServices`' own detection so the two cannot disagree about
 * whether a host is present: explicit env wins, else a built checkout at /app.
 */
/**
 * `PAPERCLIP_HOST=` (exported empty) means "no host", but `??` does not catch
 * an empty string — `process.env.PAPERCLIP_HOST ?? "/app"` yields `""`, and the
 * probes then look for a host under `/node_modules`. Normalize once, here, so
 * both scripts agree on what "set" means.
 */
export function hostEnv(env = process.env) {
  const raw = env.PAPERCLIP_HOST;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

export function detectHost(env = process.env) {
  const explicit = hostEnv(env);
  if (explicit) {
    const root = resolve(explicit);
    return { root, present: existsSync(join(root, "server", "dist")), from: "PAPERCLIP_HOST" };
  }
  if (existsSync("/app/server/dist")) return { root: "/app", present: true, from: "autodetected /app" };
  return { root: null, present: false, from: null };
}

/**
 * Strict when a host was asked for, unless explicitly opted out.
 *
 * Note this keys off PAPERCLIP_HOST being SET, not off the checkout being
 * usable. Pointing at a host whose `server/dist` is missing is precisely the
 * case that used to skip its way to a green gate, so it must be strict.
 */
export function probePolicy(env = process.env) {
  const host = detectHost(env);
  const optedOut = env[SKIP_OPT_OUT] === "1";
  const hostRequested = Boolean(hostEnv(env)) || host.present;
  return {
    host,
    optedOut,
    hostRequested,
    strict: hostRequested && !optedOut,
  };
}

/** One line, printed by both scripts, saying which regime this run is under. */
export function describePolicy(policy) {
  if (policy.strict) {
    return `strict: a host was requested (${policy.host.from ?? "PAPERCLIP_HOST"}), so a check that cannot run is a FAILURE`;
  }
  if (policy.optedOut) {
    return `permissive: ${SKIP_OPT_OUT}=1 — skips are tolerated and this run cannot back a release`;
  }
  return "permissive: no host checkout reachable — mirror fallbacks are expected, and this run is NOT the pre-tag host gate";
}

function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Record what a `verify:host` run actually executed.
 *
 * The receipt exists because the release path cannot re-run these probes: CI
 * has no checkout, so `npm run verify` inside `release.yml` legitimately takes
 * the mirror path. Something has to carry "a human ran the real gate, on this
 * commit, and nothing skipped" from the machine that could run it to the check
 * that needs to know. A claim in a card is not that; a file naming the commit
 * and the counts is.
 *
 * Each script writes its own section, so a receipt is only complete when both
 * have run against the same commit.
 */
export function writeReceipt(section, payload, policy) {
  const path = receiptPath();
  const commit = headCommit();
  let receipt = { version: 1 };
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8"));
      // A receipt only ever describes one commit. Moving to a new one discards
      // the old sections rather than letting half of it silently age.
      if (existing.commit === commit) receipt = existing;
    } catch {
      /* a corrupt receipt is replaced, never trusted */
    }
  }
  receipt.commit = commit;
  receipt[section] = {
    ...payload,
    strict: policy.strict,
    optedOut: policy.optedOut,
    hostRoot: policy.host.root,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/**
 * Read a receipt and decide whether it backs `commit`.
 *
 * Returns `{ ok, reason, receipt }`. Every rejection names what to do, because
 * the answer is always the same one command and the caller should not have to
 * reconstruct it.
 */
export function readReceipt(commit) {
  const path = receiptPath();
  if (!existsSync(path)) {
    return { ok: false, reason: "no receipt: PAPERCLIP_HOST=/app npm run verify:host has not been run from this checkout" };
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: `receipt is unreadable (${error.message}) — re-run PAPERCLIP_HOST=/app npm run verify:host` };
  }
  if (receipt.commit !== commit) {
    return {
      ok: false,
      reason: `receipt is for ${receipt.commit ?? "<no commit>"}, not ${commit} — re-run PAPERCLIP_HOST=/app npm run verify:host on this commit`,
      receipt,
    };
  }
  const sections = ["manifest", "stockControls"];
  const missing = sections.filter((name) => !receipt[name]);
  if (missing.length > 0) {
    return { ok: false, reason: `receipt is missing section(s): ${missing.join(", ")} — run the full verify:host, not one script`, receipt };
  }
  const permissive = sections.filter((name) => !receipt[name].strict);
  if (permissive.length > 0) {
    return { ok: false, reason: `${permissive.join(", ")} ran permissively (no host, or ${SKIP_OPT_OUT}=1) — that run proved nothing about the host`, receipt };
  }
  const skipped = sections.filter((name) => (receipt[name].skipped ?? 0) > 0);
  if (skipped.length > 0) {
    return { ok: false, reason: `${skipped.join(", ")} recorded skipped check(s) — the gate did not fully execute`, receipt };
  }
  const ran = sections.reduce((total, name) => total + (receipt[name].checksRun ?? 0), 0);
  if (ran === 0) {
    return { ok: false, reason: "receipt records zero executed checks", receipt };
  }
  return { ok: true, reason: `${ran} host check(s) executed at ${receipt.manifest.hostRoot} with no skips`, receipt };
}
