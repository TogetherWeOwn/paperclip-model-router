import { isReservedLiteralHost } from "../config/upstream-constraints.js";
import { normalizeAntigravityAuthFiles } from "./antigravity.js";
import { normalizeCapacityPayload } from "./normalize.js";
import type { CapacitySnapshot, CapacitySourceConfig } from "./types.js";

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

function failure(source: CapacitySourceConfig, fetchedAt: string, error: string): CapacitySnapshot {
  return { fetchedAt, source: source.id, evidence: [], error };
}

export async function readCapacitySource(input: {
  source: CapacitySourceConfig;
  http: CapacityHttpClient;
  apiKey: string | null;
  now: () => string;
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
  if (!response.contentType?.toLowerCase().split(";", 1)[0]?.trim().endsWith("/json") && !response.contentType?.toLowerCase().split(";", 1)[0]?.trim().endsWith("+json")) return failure(input.source, fetchedAt, "capacity-unexpected-media-type");
  if (response.body === null || typeof response.body !== "object") return failure(input.source, fetchedAt, "capacity-invalid-json");
  return input.source.kind === "antigravity-auth-files"
    ? normalizeAntigravityAuthFiles({ payload: response.body, source: input.source, fetchedAt })
    : normalizeCapacityPayload({ payload: response.body, source: input.source, fetchedAt });
}
