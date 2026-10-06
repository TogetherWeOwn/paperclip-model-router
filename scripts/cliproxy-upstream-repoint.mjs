#!/usr/bin/env node
/**
 * Immutable upstream repoint transformer: retired compatible-upstream baseUrl
 * -> healthy CLIProxy baseUrl, plus an approved credential-secret-ref swap.
 *
 * Pattern: deterministic backup -> payload mapping with a byte-identity guard
 * on everything outside the two intended fields. The operator takes a backup
 * with `plugin config --json`, runs this script, and writes the payload back
 * with the full-replacement config route. See
 * docs/operator/cliproxy-upstream-repoint-packet.md for the exact commands,
 * rollback, and verification steps.
 *
 * Deliberately no live reads, writes, probes, or restarts here: this script
 * only rewrites JSON. It never touches credentials -- the replacement secret
 * id arrives as an argv UUID and is echoed nowhere except into the payload.
 *
 * Usage:
 *   node scripts/cliproxy-upstream-repoint.mjs \
 *     --input BACKUP.json --output PAYLOAD.json \
 *     --credential-secret-id <uuid-of-approved-cliproxy-ref> \
 *     [--remap old-id=new-id ...] [--merge "target srcA srcB" ...]
 *
 * --merge accepts the quoted triple ("target srcA srcB", the canonical form
 * used by --flags-file and the runbook) or three separate argv tokens
 * (--merge target srcA srcB); both parse to the same triple and fail closed
 * otherwise.
 *
 * --remap renames a configured model id whose verbatim form is proven absent
 * from the live CLIProxy catalogue (dynamic evidence, never static alias
 * inspection). Each remap target must already be catalogue-verified. --disable
 * sets enabled:false on a configured id with no catalogue candidate; it is the
 * reversible disposition for unserved ids (entries preserved, selection
 * stopped) and needs an explicit policy decision before use. --merge collapses
 * two lane-label twins onto one served id: the enabled twin wins so active
 * coverage never silently goes dark, the loser is disabled, and the survivor
 * keeps its entire record. --flags-file reads bulk actions from a file (one
 * flag plus its values per line) and is the operator runbook's invocation
 * shape. The guard proves the roster is
 * otherwise untouched.
 */

import fs from "node:fs";

const RETIRED_BASE_URL = "https://router.infextion.net";
const HEALTHY_BASE_URL = "https://cliproxy.infextion.net";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function fail(message) {
  console.error(`cliproxy-upstream-repoint: ${message}`);
  process.exit(1);
}

function clone(value) {
  return structuredClone(value);
}

/** Canonical ordering so "everything else byte-identical" is checkable. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

/**
 * Runtime liveness: a model row with no `enabled` key is enabled.
 * Mirrors src/config/resolve.ts:146 (`pickBoolean(raw.enabled, true)`) and
 * the schema default (`enabled: { type: "boolean", default: true }`). Only an
 * explicit `enabled: false` is dark. Anything else (missing key, true, or a
 * non-boolean that the resolver folds to the default) counts as live.
 */
function isLive(entry) {
  return entry?.enabled !== false;
}

const FLAG_ARITY = { "--remap": 1, "--disable": 1, "--drop": 1, "--merge": 3 };

/**
 * Expand --flags-file FILE mates into raw argv tokens before pair parsing.
 * Each non-empty line must be a known roster flag plus its values
 * (`--remap old=new`, `--disable id`, `--drop id`,
 * `--merge target srcA srcB`); anything else fails. This is the shape the
 * operator runbook uses, so the runbook's literal command is covered by
 * spec, not just self-parsed in tests.
 */
function expandFlagFiles(argv) {
  const expanded = [];
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`invalid argument near ${key ?? "<end>"}`);
    // --merge takes three ids: the quoted triple ("target srcA srcB", the
    // canonical flags-file/runbook shape) or three separate argv tokens
    // (--merge target srcA srcB). Normalize both to one triple token.
    if (key === "--merge") {
      const parts = value.split(" ").filter((part) => part.length > 0);
      if (parts.length === 3) {
        expanded.push(key, parts.join(" "));
        index += 2;
        continue;
      }
      const nextA = argv[index + 1];
      const nextB = argv[index + 2];
      const nextC = argv[index + 3];
      if (
        nextA !== undefined && !nextA.startsWith("--") && !nextA.includes(" ") &&
        nextB !== undefined && !nextB.startsWith("--") &&
        nextC !== undefined && !nextC.startsWith("--")
      ) {
        expanded.push(key, `${nextA} ${nextB} ${nextC}`);
        index += 4;
        continue;
      }
      fail(`--merge must be "target srcA srcB" (quoted) or --merge target srcA srcB, got ${JSON.stringify(value)}`);
    }
    if (key !== "--flags-file") {
      expanded.push(key, value);
      index += 2;
      continue;
    }
    let lines;
    try {
      lines = fs.readFileSync(value, "utf8").split("\n");
    } catch {
      fail(`cannot read flags file ${JSON.stringify(value)}`);
    }
    for (const line of lines.filter((candidate) => candidate.length > 0)) {
      const [flag, ...values] = line.trim().split(/\s+/);
      const arity = FLAG_ARITY[flag ?? ""];
      if (arity === undefined || values.length !== arity) {
        fail(`unparseable flags-file line ${JSON.stringify(line)} (expected a roster flag plus ${arity ?? "?"} values)`);
      }
      expanded.push(flag, values.join(" "));
    }
    index += 2;
  }
  return expanded;
}

function parseArgs(rawArgv) {
  const argv = expandFlagFiles(rawArgv);
  const options = { remap: [], disable: [], drop: [], merge: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail(`invalid argument near ${key ?? "<end>"}`);
    if (key === "--remap") {
      const equals = value.indexOf("=");
      if (equals <= 0 || equals === value.length - 1) fail(`--remap must be old-id=new-id, got ${JSON.stringify(value)}`);
      options.remap.push({ from: value.slice(0, equals), to: value.slice(equals + 1) });
    } else if (key === "--disable") {
      options.disable.push(value);
    } else if (key === "--drop") {
      options.drop.push(value);
    } else if (key === "--merge") {
      const parts = value.split(" ").filter((part) => part.length > 0);
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) fail(`--merge must be "target srcA srcB" (quoted) or --merge target srcA srcB, got ${JSON.stringify(value)}`);
      const [target, srcA, srcB] = parts;
      options.merge.push({ target, srcA, srcB });
    } else {
      options[key.slice(2)] = value;
    }
  }
  if (!options.input || !options.output || !options["credential-secret-id"]) {
    fail('usage: cliproxy-upstream-repoint.mjs --input FILE --output FILE --credential-secret-id UUID [--remap old=new ...] [--disable id ...] [--drop id ...] [--merge "target srcA srcB" ...] [--flags-file FILE ...]');
  }
  return options;
}

function touchedIds(options) {
  return [
    ...options.remap.flatMap((pair) => [pair.from, pair.to]),
    ...options.disable,
    ...options.drop,
    ...options.merge.flatMap((triple) => [triple.target, triple.srcA, triple.srcB]),
  ];
}

function assertDeclaredOnce(options) {
  const seen = new Set();
  for (const id of touchedIds(options)) {
    if (seen.has(id)) fail(`id ${JSON.stringify(id)} is declared twice across --remap/--disable/--drop/--merge`);
    seen.add(id);
  }
}

function unwrapConfig(backup) {
  const config = backup?.configJson ?? backup?.config_json ?? backup;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("input does not contain a config object (expected plugin config --json backup)");
  }
  return clone(config);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentialSecretId = options["credential-secret-id"];
  if (!UUID_RE.test(credentialSecretId)) fail("--credential-secret-id must be a UUID");
  if (credentialSecretId !== credentialSecretId.toLowerCase()) {
    fail("--credential-secret-id must be lowercase (secret ids are canonical UUIDs)");
  }

  const backup = JSON.parse(fs.readFileSync(options.input, "utf8"));
  const config = unwrapConfig(backup);
  const before = clone(config);

  const upstream = config.upstream;
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    fail("config.upstream is missing: refusing to invent an upstream block");
  }
  if (upstream.baseUrl !== RETIRED_BASE_URL) {
    fail(
      `expected upstream.baseUrl ${RETIRED_BASE_URL}; found ${JSON.stringify(upstream.baseUrl ?? null)} ` +
        "(wrong input backup, or already re-pointed -- refusing double-apply)",
    );
  }
  const protocol = upstream.protocol;
  if (protocol !== "openai-chat-completions" && protocol !== "anthropic-messages") {
    fail(`unexpected upstream.protocol ${JSON.stringify(protocol)}: refusing to migrate an unknown protocol`);
  }
  const oldRef = upstream.credentialSecretRef;
  if (!oldRef || typeof oldRef !== "object" || oldRef.type !== "secret_ref") {
    fail("upstream.credentialSecretRef is not a secret_ref object: refusing to migrate an unknown credential shape");
  }
  if (oldRef.secretId === credentialSecretId) {
    fail("replacement secret id equals the current one: nothing to do");
  }

  config.upstream = {
    ...upstream,
    baseUrl: HEALTHY_BASE_URL,
    credentialSecretRef: { ...oldRef, type: "secret_ref", secretId: credentialSecretId },
  };

  if (!Array.isArray(config.models)) fail("config.models is missing: refusing to emit a model-less payload");
  assertDeclaredOnce(options);
  const remaps = options.remap ?? [];
  const remappedIds = [];
  for (const { from, to } of remaps) {
    if (from === to) fail(`--remap ${JSON.stringify(from)} is a no-op`);
    const hits = config.models.filter((model) => model?.id === from);
    if (hits.length !== 1) {
      fail(`--remap source ${JSON.stringify(from)} matches ${hits.length} models (expected exactly 1)`);
    }
    if (config.models.some((model) => model?.id === to)) {
      fail(`--remap target ${JSON.stringify(to)} already exists in the roster`);
    }
    hits[0].id = to;
    remappedIds.push(`${from} -> ${to}`);
  }

  // Twin coalescing: two lane labels for one model collapse onto the served
  // id. The survivor keeps its ENTIRE record (all non-id metadata); the loser
  // is disabled, never deleted. Survivor choice is live-state driven: the
  // live twin wins so active coverage can never silently go dark. Live means
  // runtime-enabled (isLive): only an explicit `enabled: false` is dark; a
  // missing `enabled` key counts as enabled, mirroring
  // src/config/resolve.ts:146. A both-live pair is a genuine ambiguity and
  // fails for a policy decision; a both-dark pair keeps the first-listed
  // source (deterministic; the entry stays unselected either way, so the
  // choice is metadata-only).
  const merges = options.merge ?? [];
  const mergedIds = [];
  const restoreMerges = [];
  for (const { target, srcA, srcB } of merges) {
    if (target === srcA || target === srcB || srcA === srcB) {
      fail(`--merge ${JSON.stringify(target)} ${JSON.stringify(srcA)} ${JSON.stringify(srcB)} must name three distinct ids`);
    }
    const hitA = config.models.filter((model) => model?.id === srcA);
    const hitB = config.models.filter((model) => model?.id === srcB);
    if (hitA.length !== 1 || hitB.length !== 1) {
      fail(`--merge sources ${JSON.stringify(srcA)} (${hitA.length}) / ${JSON.stringify(srcB)} (${hitB.length}) must each match exactly 1 model`);
    }
    if (config.models.some((model) => model?.id === target)) {
      fail(`--merge target ${JSON.stringify(target)} already exists in the roster`);
    }
    const entryA = hitA[0];
    const entryB = hitB[0];
    const enabledA = isLive(entryA);
    const enabledB = isLive(entryB);
    if (enabledA && enabledB) {
      fail(`--merge sources ${JSON.stringify(srcA)} and ${JSON.stringify(srcB)} are both live (enabled or default-enabled): dropping either loses coverage, needs a policy decision`);
    }
    const winner = enabledA ? entryA : enabledB ? entryB : entryA;
    const loser = winner === entryA ? entryB : entryA;
    restoreMerges.push({
      target,
      winnerId: winner.id,
      loserId: loser.id,
      loserHadKey: "enabled" in loser,
      loserValue: loser.enabled,
    });
    winner.id = target;
    loser.enabled = false;
    mergedIds.push(`${srcA} + ${srcB} -> ${target} (kept ${winner === entryA ? srcA : srcB})`);
  }

  const disables = options.disable ?? [];
  const disabledIds = [];
  const restoreEnabled = [];
  for (const id of disables) {
    if (remaps.some((pair) => pair.from === id || pair.to === id)) {
      fail(`--disable ${JSON.stringify(id)} is also remapped: declare each id once`);
    }
    const hits = config.models.filter((model) => model?.id === id);
    if (hits.length !== 1) {
      fail(`--disable ${JSON.stringify(id)} matches ${hits.length} models (expected exactly 1)`);
    }
    const entry = hits[0];
    restoreEnabled.push({ id, hadKey: "enabled" in entry, value: entry.enabled });
    entry.enabled = false;
    disabledIds.push(id);
  }

  const drops = options.drop ?? [];
  const droppedEntries = [];
  for (const id of drops) {
    const index = config.models.findIndex((model) => model?.id === id);
    if (index < 0) fail(`--drop ${JSON.stringify(id)} matches no model (expected exactly 1)`);
    const [entry] = config.models.splice(index, 1);
    if (config.models.some((model) => model?.id === id)) {
      fail(`--drop ${JSON.stringify(id)} matches more than one model: refusing to guess`);
    }
    droppedEntries.push({ id, index, entry: clone(entry) });
  }

  // Immutability guard: restoring the intended fields must reproduce the
  // input exactly. Anything else the script changed (or dropped) fails here.
  const restored = clone(config);
  restored.upstream.baseUrl = before.upstream.baseUrl;
  restored.upstream.credentialSecretRef = before.upstream.credentialSecretRef;
  for (const { from, to } of remaps) {
    const hit = restored.models.find((model) => model?.id === to);
    if (hit) hit.id = from;
  }
  for (const record of restoreMerges) {
    const survivor = restored.models.find((model) => model?.id === record.target);
    const loser = restored.models.find((model) => model?.id === record.loserId);
    if (survivor) survivor.id = record.winnerId;
    if (loser) {
      if (record.loserHadKey) loser.enabled = record.loserValue;
      else delete loser.enabled;
    }
  }
  for (const id of disabledIds) {
    const hit = restored.models.find((model) => model?.id === id);
    const saved = restoreEnabled.find((record) => record.id === id);
    if (hit && saved) {
      if (saved.hadKey) hit.enabled = saved.value;
      else delete hit.enabled;
    }
  }
  for (const { id, index, entry } of [...droppedEntries].sort((a, b) => a.index - b.index)) {
    restored.models.splice(index, 0, entry);
  }
  if (!same(restored, before)) {
    fail("repoint changed fields outside upstream.baseUrl, upstream.credentialSecretRef.secretId, and declared --remap/--disable/--drop/--merge actions");
  }

  fs.writeFileSync(options.output, `${JSON.stringify({ configJson: config }, null, 2)}\n`, { mode: 0o600 });

  console.error(JSON.stringify({
    retiredBaseUrl: RETIRED_BASE_URL,
    healthyBaseUrl: HEALTHY_BASE_URL,
    protocol,
    credentialSecretRefReplaced: true,
    remaps: remappedIds,
    merges: mergedIds,
    disabled: disabledIds,
    dropped: droppedEntries.map((record) => record.id),
    enabledBefore: before.models.filter(isLive).map((model) => model.id),
    enabledAfter: config.models.filter(isLive).map((model) => model.id),
    modelCount: config.models.length,
    modelIds: config.models.map((model) => model?.id ?? null),
  }, null, 2));
}

main();
