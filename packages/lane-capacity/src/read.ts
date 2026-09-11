import { normalizeCapacityPayload } from "./normalize.js";
import { evaluateLanePace, normalizeLaneDocument } from "./pace.js";
import type { LanePaceDefinition, LanePaceVerdict, PacePolicy } from "./pace.js";
import type { CapacitySnapshot, CapacitySourceDefinition } from "./types.js";
import { isReservedLiteralHost } from "./url-policy.js";

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

function failure(source: CapacitySourceDefinition, fetchedAt: string, error: string): CapacitySnapshot {
  return { fetchedAt, source: source.id, evidence: [], error };
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
}): Promise<CapacitySnapshot> {
  const fetchedAt = input.now();
  let parsed: URL;
  try { parsed = new URL(input.source.statusUrl); } catch { return failure(input.source, fetchedAt, "capacity-url-rejected"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || isReservedLiteralHost(parsed.hostname)) {
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
  const snapshot = normalizeCapacityPayload({ payload: response.body, source: input.source, fetchedAt });
  // TOG-2139: pace rides the same response — one fetch, one guard chain. The
  // verdict is present even when the capacity normalizer found no records
  // (e.g. a lane document shape the evidence windows don't match), because
  // pace reads `records[]` per its own definition.
  return { ...snapshot, pace: paceVerdict({ document: response.body, lane: input.lane, policy: input.pacePolicy, now: input.now }) };
}
