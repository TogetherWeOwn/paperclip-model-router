#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prerequisitePath = path.join(root, "docs/operator/tog-2922-pace-prerequisites.json");
const prerequisite = JSON.parse(fs.readFileSync(prerequisitePath, "utf8"));
const expectedSources = prerequisite.capacityRouting.sourcesById;
const expectedIds = Object.keys(expectedSources).sort();

function fail(message) {
  console.error(`tog-2922-config-delta: ${message}`);
  process.exit(1);
}

function clone(value) {
  return structuredClone(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function unwrapConfig(value) {
  const config = value?.configJson ?? value?.config_json ?? value;
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("input does not contain a config object");
  return clone(config);
}

function writePayload(file, config) {
  fs.writeFileSync(file, `${JSON.stringify({ configJson: config }, null, 2)}\n`, { mode: 0o600 });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value) fail(`invalid argument near ${key ?? "<end>"}`);
    options[key.slice(2)] = value;
  }
  if (!command || !["prepare", "enable", "restore"].includes(command)) {
    fail("usage: tog-2922-config-delta.mjs prepare|enable|restore --input FILE --output FILE");
  }
  if (!options.input || !options.output) fail("--input and --output are required");
  return { command, input: options.input, output: options.output };
}

function assertSourceSet(config) {
  const sources = config.capacityRouting?.sources;
  if (!Array.isArray(sources)) fail("capacityRouting.sources is missing");
  const actualIds = sources.map((source) => source?.id).sort();
  if (!same(actualIds, expectedIds)) {
    fail(`expected exactly ${expectedIds.join(", ")}; got ${actualIds.join(", ")}`);
  }
  return sources;
}

function withoutPaceDelta(config) {
  const comparable = clone(config);
  if (comparable.capacityRouting) {
    delete comparable.capacityRouting.paceOrdering;
    delete comparable.capacityRouting.pacePolicy;
    for (const source of comparable.capacityRouting.sources ?? []) delete source.pace;
  }
  return comparable;
}

function prepare(config) {
  const before = clone(config);
  const sources = assertSourceSet(config);
  config.capacityRouting.pacePolicy = clone(prerequisite.capacityRouting.pacePolicy);
  config.capacityRouting.paceOrdering = false;
  for (const source of sources) source.pace = clone(expectedSources[source.id].pace);
  if (!same(withoutPaceDelta(before), withoutPaceDelta(config))) {
    fail("prepare changed fields outside capacityRouting.pacePolicy, paceOrdering, and sources[].pace");
  }
  return config;
}

function enable(config) {
  const before = clone(config);
  const sources = assertSourceSet(config);
  if (config.capacityRouting.paceOrdering !== false) fail("enable input must have paceOrdering=false");
  if (!same(config.capacityRouting.pacePolicy, prerequisite.capacityRouting.pacePolicy)) fail("pacePolicy does not match the reviewed prerequisite");
  for (const source of sources) {
    if (!same(source.pace, expectedSources[source.id].pace)) fail(`pace block drifted for ${source.id}`);
  }
  config.capacityRouting.paceOrdering = true;
  const expected = clone(before);
  expected.capacityRouting.paceOrdering = true;
  if (!same(config, expected)) fail("enable changed more than capacityRouting.paceOrdering");
  return config;
}

const { command, input, output } = parseArgs(process.argv.slice(2));
const original = readJson(input);
const config = unwrapConfig(original);
const result = command === "prepare" ? prepare(config) : command === "enable" ? enable(config) : config;
writePayload(output, result);
console.error(JSON.stringify({
  command,
  output,
  sourceIds: assertSourceSet(result).map((source) => source.id),
  modelCount: Array.isArray(result.models) ? result.models.length : null,
  paceOrdering: result.capacityRouting.paceOrdering,
}, null, 2));
