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
 *     [--remap old-id=new-id ...]
 *
 * --remap renames a configured model id whose verbatim form is proven absent
 * from the live CLIProxy catalogue (dynamic evidence, never static alias
 * inspection). Each remap target must already be catalogue-verified. The guard
 * proves the roster is otherwise untouched.
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

function parseArgs(argv) {
  const options = { remap: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail(`invalid argument near ${key ?? "<end>"}`);
    if (key === "--remap") {
      const equals = value.indexOf("=");
      if (equals <= 0 || equals === value.length - 1) fail(`--remap must be old-id=new-id, got ${JSON.stringify(value)}`);
      options.remap.push({ from: value.slice(0, equals), to: value.slice(equals + 1) });
    } else {
      options[key.slice(2)] = value;
    }
  }
  if (!options.input || !options.output || !options["credential-secret-id"]) {
    fail("usage: cliproxy-upstream-repoint.mjs --input FILE --output FILE --credential-secret-id UUID [--remap old=new ...]");
  }
  return options;
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

  // Immutability guard: restoring the intended fields must reproduce the
  // input exactly. Anything else the script changed (or dropped) fails here.
  const restored = clone(config);
  restored.upstream.baseUrl = before.upstream.baseUrl;
  restored.upstream.credentialSecretRef = before.upstream.credentialSecretRef;
  for (const { from, to } of remaps) {
    const hit = restored.models.find((model) => model?.id === to);
    if (hit) hit.id = from;
  }
  if (!same(restored, before)) {
    fail("repoint changed fields outside upstream.baseUrl, upstream.credentialSecretRef.secretId, and declared --remap pairs");
  }

  fs.writeFileSync(options.output, `${JSON.stringify({ configJson: config }, null, 2)}\n`, { mode: 0o600 });

  console.error(JSON.stringify({
    retiredBaseUrl: RETIRED_BASE_URL,
    healthyBaseUrl: HEALTHY_BASE_URL,
    protocol,
    credentialSecretRefReplaced: true,
    remaps: remappedIds,
    modelCount: config.models.length,
    modelIds: config.models.map((model) => model?.id ?? null),
  }, null, 2));
}

main();
