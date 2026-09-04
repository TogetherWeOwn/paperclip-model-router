import { normalizeCapacityPayload } from "./normalize.js";
import type { CapacitySnapshot, CapacitySourceConfig } from "./types.js";

export interface CapacityHttpClient {
  request(input: {
    url: string;
    method: "GET";
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: unknown }>;
}

export async function readCapacitySource(input: {
  source: CapacitySourceConfig;
  http: CapacityHttpClient;
  apiKey: string | null;
  now: () => string;
}): Promise<CapacitySnapshot> {
  const fetchedAt = input.now();
  let response: { status: number; body: unknown };
  try {
    response = await input.http.request({
      url: input.source.statusUrl,
      method: "GET",
      headers: input.apiKey ? { "x-api-key": input.apiKey } : {},
    });
  } catch (error) {
    return {
      fetchedAt,
      source: input.source.id,
      lanes: [],
      error: `capacity status request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      fetchedAt,
      source: input.source.id,
      lanes: [],
      error: `capacity status rejected the credential (HTTP ${response.status})`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      fetchedAt,
      source: input.source.id,
      lanes: [],
      error: `capacity status returned HTTP ${response.status}`,
    };
  }
  return normalizeCapacityPayload({
    payload: response.body,
    source: input.source,
    fetchedAt,
  });
}
