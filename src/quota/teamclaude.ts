/**
 * teamclaude pooled-quota reader.
 *
 * Two facts about this endpoint are load-bearing and were verified against the
 * live system in TOG-150, not inferred:
 *
 *  - Utilization values are FRACTIONS in [0,1]. 1.0 means the window is
 *    exhausted. Reading them as percentages is wrong by 100x.
 *  - The endpoint is not on loopback from inside a container, and it requires an
 *    API key. Both the URL and the key are per-company configuration; neither is
 *    hardcoded and the key is only ever a secret reference.
 */

import type { QuotaGateConfig } from "../config/types.js";

export interface QuotaSnapshot {
  /** Highest utilization across the configured windows, 0..1. */
  maxUtilization: number | null;
  /** Per-window values actually found in the response. */
  windows: Record<string, number>;
  /** Windows that were configured but absent from the response. */
  missingWindows: string[];
  /** Non-fatal explanation when `maxUtilization` is null. */
  error: string | null;
  fetchedAt: string;
}

/** Minimal HTTP surface, so this is testable without a live endpoint. */
export interface QuotaHttpClient {
  request(input: {
    url: string;
    method: "GET";
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: unknown }>;
}

function collectUtilizations(payload: unknown, windows: string[]): Record<string, number> {
  const found: Record<string, number> = {};
  if (!payload || typeof payload !== "object") return found;

  // The status payload nests per-account records. Take the worst value seen for
  // each window across every account: the pool is only as healthy as the account
  // that will actually serve the next request.
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const window of windows) {
      const value = record[window];
      if (typeof value === "number" && Number.isFinite(value)) {
        found[window] = Math.max(found[window] ?? 0, value);
      }
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") visit(value);
    }
  };

  visit(payload);
  return found;
}

export async function readQuotaSnapshot(input: {
  config: QuotaGateConfig;
  http: QuotaHttpClient;
  apiKey: string | null;
  now: () => string;
}): Promise<QuotaSnapshot> {
  const { config, http, apiKey } = input;
  const fetchedAt = input.now();
  const empty: QuotaSnapshot = {
    maxUtilization: null,
    windows: {},
    missingWindows: [...config.windows],
    error: null,
    fetchedAt,
  };

  if (!config.enabled) return { ...empty, error: "quota gate disabled for this company" };
  if (!config.statusUrl) return { ...empty, error: "quotaGate.statusUrl is not configured" };

  let response: { status: number; body: unknown };
  try {
    response = await http.request({
      url: config.statusUrl,
      method: "GET",
      headers: apiKey ? { "x-api-key": apiKey } : {},
    });
  } catch (error) {
    return {
      ...empty,
      error: `quota status request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ...empty,
      error: `quota status rejected the credential (HTTP ${response.status}) — check quotaGate.apiKeySecretRef`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ...empty, error: `quota status returned HTTP ${response.status}` };
  }

  const windows = collectUtilizations(response.body, config.windows);
  const present = Object.keys(windows);
  const missing = config.windows.filter((window) => !present.includes(window));

  if (present.length === 0) {
    return {
      ...empty,
      error: `quota status carried none of the configured windows (${config.windows.join(", ")})`,
    };
  }

  return {
    maxUtilization: Math.max(...Object.values(windows)),
    windows,
    missingWindows: missing,
    error: null,
    fetchedAt,
  };
}
