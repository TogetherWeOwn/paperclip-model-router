/**
 * The sanitization boundary (contract §2).
 *
 * Two functions, and the distinction between them is the design:
 *
 *   `serializeSnapshot` builds the wire body from an ALLOWLIST. It copies named
 *   fields onto a fresh object and never spreads, so a field added upstream
 *   tomorrow cannot ride along today. Filtering a richer object would be the
 *   other approach, and it fails the moment someone adds a key nobody wrote a
 *   filter for — which is how every leak of this kind actually happens.
 *
 *   `findIdentityLeaks` is an independent DETECTOR used as a test oracle. It
 *   does not sanitize anything. It exists so the conformance suite can assert
 *   absence by a different mechanism than the one that produced the value —
 *   if the allowlist and the detector shared code, a bug in the shared part
 *   would be invisible to both.
 */

import {
  TELEMETRY_DEFAULTS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_WINDOWS,
  type ModelUsageRecord,
  type ModelUsageSnapshot,
} from "./types.js";

/**
 * Build the wire body. Every value is copied by name; nothing is spread.
 *
 * This also re-derives `serviceable` from `state` rather than trusting the
 * record, so a caller cannot hand us a record where the two disagree and have
 * it reach the wire.
 */
export function serializeSnapshot(snapshot: ModelUsageSnapshot): Record<string, unknown> {
  const models: Record<string, unknown> = {};

  for (const modelId of Object.keys(snapshot.models).sort()) {
    const record = snapshot.models[modelId];
    if (!record) continue;
    models[modelId] = serializeRecord(record);
  }

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    observedAt: snapshot.observedAt,
    staleAfterSeconds: snapshot.staleAfterSeconds,
    telemetry: snapshot.telemetry,
    reasonCode: snapshot.reasonCode,
    models,
  };
}

function serializeRecord(record: ModelUsageRecord): Record<string, unknown> {
  const state = record.state;
  return {
    serviceable: state === "available" || state === "degraded" || state === "unknown",
    state,
    utilization: record.utilization,
    remainingFraction: record.remainingFraction,
    resetsAt: record.resetsAt,
    resetInSeconds: record.resetInSeconds,
    windows: record.windows
      // A window outside the closed vocabulary is dropped, not renamed. An
      // unrecognized name is exactly where a vendor label would appear.
      .filter((window) => (TELEMETRY_WINDOWS as readonly string[]).includes(window.window))
      .map((window) => ({
        window: window.window,
        utilization: window.utilization,
        resetsAt: window.resetsAt,
        resetInSeconds: window.resetInSeconds,
      })),
    observationQuality: record.observationQuality,
  };
}

/**
 * Serialize with the §5 body cap enforced.
 *
 * On overflow this returns the outage form rather than a truncated body,
 * because a truncated snapshot that still said `available` would look complete
 * while silently missing models.
 */
export function serializeBounded(
  snapshot: ModelUsageSnapshot,
  maxBytes: number = TELEMETRY_DEFAULTS.maxBodyBytes,
): { body: string; withinLimit: boolean } {
  const body = JSON.stringify(serializeSnapshot(snapshot));
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return { body, withinLimit: true };
  const truncated = JSON.stringify(
    serializeSnapshot({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      observedAt: snapshot.observedAt,
      staleAfterSeconds: snapshot.staleAfterSeconds,
      telemetry: "unavailable",
      reasonCode: "upstream-malformed",
      models: {},
    }),
  );
  return { body: truncated, withinLimit: false };
}

// ---------------------------------------------------------------------------
// Independent leak detector — test oracle only, deliberately not shared with
// the serializer above.
// ---------------------------------------------------------------------------

/**
 * Key names that may never appear anywhere in a response, at any depth.
 * Substring-matched case-insensitively, so `providerId`, `provider_name` and
 * `PROVIDER` are all caught by one entry.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  "provider", "vendor", "upstream",
  "account", "subscription", "plan", "seat", "org", "email", "tenant",
  "connection", "node", "endpoint", "baseurl", "base_url", "host", "url",
  "combo", "strategy", "weight", "priority", "lane", "leg", "failover",
  "apikey", "api_key", "token", "secret", "credential", "authorization", "auth",
  "keygroup", "key_group",
  "payg", "billing", "cost", "spend",
  "route", "servedby", "served_by",
  "deployment", "instance", "region", "cluster", "container",
];

/**
 * Value patterns that indicate credential material or an identity even when the
 * key looks innocent. A leak often arrives inside a `reason` string rather than
 * under an obviously-named key, which is the case §2.2 forbids propagating
 * upstream error text for.
 */
const FORBIDDEN_VALUE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "sk- credential", pattern: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { label: "oma_ access token", pattern: /\boma_[A-Za-z0-9_-]{6,}/ },
  { label: "bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/i },
  { label: "url", pattern: /\bhttps?:\/\//i },
  { label: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
];

/**
 * Model IDs are the one exception: they are opaque and permitted, and they
 * legitimately contain vendor-looking substrings (`oc/claude-opus-5`). This
 * detector therefore checks model IDs as KEYS only and does not pattern-match
 * their text — see §2.1, the ID is not evidence of a provider because the
 * plugin already holds it.
 */
export interface IdentityLeak {
  path: string;
  detail: string;
}

export function findIdentityLeaks(value: unknown, modelIds: readonly string[] = []): IdentityLeak[] {
  const leaks: IdentityLeak[] = [];
  const permittedKeys = new Set<string>(modelIds);

  const visit = (node: unknown, path: string, keyIsModelId: boolean): void => {
    if (typeof node === "string") {
      // A model ID appearing as a VALUE is fine; it is the permitted key.
      if (!permittedKeys.has(node)) {
        for (const { label, pattern } of FORBIDDEN_VALUE_PATTERNS) {
          if (pattern.test(node)) leaks.push({ path, detail: `${label} in value` });
        }
      }
      return;
    }
    if (node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`, false));
      return;
    }

    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const isModelIdKey = permittedKeys.has(key);
      if (!isModelIdKey) {
        const normalized = key.toLowerCase();
        for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
          if (normalized.includes(fragment)) {
            leaks.push({ path: childPath, detail: `forbidden key fragment "${fragment}"` });
          }
        }
      }
      visit(entry, childPath, isModelIdKey);
    }
    void keyIsModelId;
  };

  visit(value, "", false);
  return leaks;
}
