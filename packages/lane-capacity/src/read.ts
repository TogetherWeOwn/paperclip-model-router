import { evidenceFromContract, looksLikeModelUsageSnapshot } from "./contract.js";
import { normalizeCapacityPayload } from "./normalize.js";
import { evaluateLanePace, normalizeLaneDocument } from "./pace.js";
import type { LanePaceDefinition, LanePaceVerdict, PacePolicy } from "./pace.js";
import type { CapacityReasonCode, CapacitySnapshot, CapacitySourceDefinition } from "./types.js";
import { checkResolvedHost, isReservedLiteralHost } from "./url-policy.js";
import type { HostAddressResolver } from "./url-policy.js";

export interface CapacityHttpClient {
  request(input: {
    url: string;
    method: "GET";
    headers: Record<string, string>;
    redirect: "manual";
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{ status: number; contentType: string | null; body: unknown; responseBytes: number; redirected: boolean }>;
}

function failure(
  source: CapacitySourceDefinition,
  fetchedAt: string,
  reasonCode: CapacityReasonCode,
): CapacitySnapshot {
  return {
    fetchedAt,
    source: source.id,
    evidence: [],
    telemetry: "unavailable",
    reasonCode,
    error: reasonCode,
  };
}

/**
 * TOG-2139 (slice 6): evaluate the lane's pace from the same document the
 * capacity evidence was normalized from. Never throws and never contributes
 * to `snapshot.error` — a malformed lane document degrades to an `unknown`
 * verdict (fail-neutral), exactly like missing capacity telemetry.
 */
function paceVerdict(input: {
  document: unknown;
  lane: LanePaceDefinition | undefined;
  policy: PacePolicy | undefined;
  now: () => string;
}): LanePaceVerdict | null {
  if (!input.lane) return null;
  try {
    return evaluateLanePace({
      observation: normalizeLaneDocument({ document: input.document, definition: input.lane }),
      asOf: input.now(),
      policy: input.policy,
    });
  } catch {
    return null;
  }
}

export async function readCapacitySource(input: {
  source: CapacitySourceDefinition;
  http: CapacityHttpClient;
  apiKey: string | null;
  now: () => string;
  lane?: LanePaceDefinition;
  pacePolicy?: PacePolicy;
  /**
   * TOG-7884 (gap G6): request-time DNS resolution hook. The literal-host
   * check above only sees IP literals; a DNS name resolving to 10.x /
   * 169.254.x / ::1 sails through it. The resolver closes that rebinding gap
   * on this path. Defaults to the worker's real resolver; tests inject a mock.
   */
  resolveHostAddresses?: HostAddressResolver;
}): Promise<CapacitySnapshot> {
  const fetchedAt = input.now();
  let parsed: URL;
  try { parsed = new URL(input.source.statusUrl); } catch { return failure(input.source, fetchedAt, "capacity-url-rejected"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || isReservedLiteralHost(parsed.hostname)) {
    return failure(input.source, fetchedAt, "capacity-url-rejected");
  }
  const resolved = await checkResolvedHost(parsed.hostname, input.resolveHostAddresses);
  if (!resolved.allowed) {
    return failure(input.source, fetchedAt, "capacity-url-rejected");
  }
  let response: Awaited<ReturnType<CapacityHttpClient["request"]>>;
  try {
    response = await input.http.request({
      url: input.source.statusUrl,
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        ...(input.apiKey ? { "x-api-key": input.apiKey } : {}),
      },
      redirect: "manual",
      timeoutMs: input.source.requestTimeoutMs,
      maxResponseBytes: input.source.maxResponseBytes,
    });
  } catch {
    return failure(input.source, fetchedAt, "capacity-request-failed");
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) return failure(input.source, fetchedAt, "capacity-redirect-refused");
  if (response.responseBytes > input.source.maxResponseBytes) return failure(input.source, fetchedAt, "capacity-response-too-large");
  if (response.status === 401 || response.status === 403) return failure(input.source, fetchedAt, "capacity-authentication-failed");
  if (response.status < 200 || response.status >= 300) return failure(input.source, fetchedAt, "capacity-http-failed");
  const mediaType = response.contentType?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) return failure(input.source, fetchedAt, "capacity-unexpected-media-type");
  if (response.body === null || typeof response.body !== "object") return failure(input.source, fetchedAt, "capacity-invalid-json");
  // TOG-7163 (TOG-1921 audit of PR #41): per-record explicit status
  // (`status: "error"` on ONE credential) must not globally suppress the
  // healthy windows of sibling records. The window normalizer below reads
  // windows per record, so the only global signal left is the snapshot-level
  // `error`: emit it only when NO record yielded usable telemetry, never as a
  // blanket over a mixed pool. A transported `error` with zero evidence is the
  // caller's signal to treat the failure as sticky (keep serving the last good
  // snapshot) rather than as an auth revocation (drop the lane).
  // A payload carrying `telemetry` is claiming to be a
  // `model-usage-telemetry-v1` snapshot, so it is held to that contract —
  // including having its `schemaVersion` rejected if we do not implement it.
  // Anything else, including a legacy lane document that also happens to
  // carry `schemaVersion`, goes down the legacy tree-walking path.
  const snapshot = looksLikeModelUsageSnapshot(response.body)
    ? evidenceFromContract({ payload: response.body, source: input.source, fetchedAt })
    : normalizeCapacityPayload({ payload: response.body, source: input.source, fetchedAt });
  // TOG-2139: pace rides the same response — one fetch, one guard chain. The
  // verdict is present even when the capacity normalizer found no records
  // (e.g. a lane document shape the evidence windows don't match), because
  // pace reads `records[]` per its own definition.
  return { ...snapshot, pace: paceVerdict({ document: response.body, lane: input.lane, policy: input.pacePolicy, now: input.now }) };
}
