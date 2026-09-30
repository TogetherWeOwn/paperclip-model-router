import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

import type { CompatibleUpstreamConfig } from "../config/types.js";
import { catalogueUrl, requestHeaders } from "../inference/adapters.js";
import type { CatalogueProbe } from "./types.js";

/** Catalogues are small; anything larger than this is not one. */
const MAX_CATALOGUE_BYTES = 1_048_576;

/**
 * Pull the model ids out of an OpenAI-style `{ data: [{ id }] }` catalogue.
 * Anthropic's `/v1/models` returns the same shape, so one reader serves both.
 * Returns `null` when the payload is not a catalogue — an unparseable body is
 * indeterminate, not evidence that every model is dead.
 */
export function parseCatalogue(payload: unknown): Set<string> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string") {
      ids.add((entry as { id: string }).id);
    }
  }
  return ids;
}

/**
 * Read the configured upstream's model catalogue once.
 *
 * Every failure path returns `modelIds: null` (indeterminate) rather than an
 * empty set. An empty set means "the upstream answered and listed nothing",
 * which legitimately disables the table; a failed request must not.
 */
export async function probeCatalogue(input: {
  http: PluginHttpClient;
  config: CompatibleUpstreamConfig;
  credential: string;
}): Promise<CatalogueProbe> {
  let url: string;
  let headers: Record<string, string>;
  try {
    url = catalogueUrl(input.config);
    headers = requestHeaders(input.config, input.credential);
  } catch {
    return { modelIds: null, detail: "the configured upstream is invalid", status: null };
  }

  const request = input.http.fetch(url, { method: "GET", headers, redirect: "manual" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try {
    response = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe-timeout")), input.config.requestTimeoutMs);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "probe-timeout") request.catch(() => undefined);
    return { modelIds: null, detail: "the upstream catalogue could not be reached", status: null };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (response.status < 200 || response.status >= 300) {
    // Includes 401/403: a credential problem is an account-health signal about
    // the whole upstream, not proof that any individual model is gone.
    return {
      modelIds: null,
      detail: `the upstream catalogue returned HTTP ${response.status}`,
      status: response.status,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { modelIds: null, detail: "the upstream catalogue body could not be read", status: response.status };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_CATALOGUE_BYTES) {
    return { modelIds: null, detail: "the upstream catalogue exceeded the size limit", status: response.status };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { modelIds: null, detail: "the upstream catalogue was not JSON", status: response.status };
  }

  const modelIds = parseCatalogue(parsed);
  if (!modelIds) {
    return { modelIds: null, detail: "the upstream catalogue had an unrecognised shape", status: response.status };
  }
  return {
    modelIds,
    detail: `the upstream catalogue listed ${modelIds.size} model(s)`,
    status: response.status,
  };
}
