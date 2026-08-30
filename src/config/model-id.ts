/**
 * TOG-681 §5: a bare, unprefixed model id carries the same fail-open hazard as
 * a bare id in agent config — it can resolve onto whatever leg the upstream
 * happens to pick, including a paid one, without ever failing at config time.
 * A provider-pinned id fails closed instead: the upstream rejects an id it does
 * not own rather than silently substituting a route nobody chose.
 *
 * This is reported as a warning and never an error. Both shipped fixtures and
 * every existing company config carry bare ids; promoting this to an error
 * would invalidate live configuration to make a point about a hazard that has
 * not yet cost anything. The operator sees it through the native
 * `POST /api/plugins/:pluginId/config/test` surface and decides.
 */

/** A provider-pinned id carries an explicit `provider/model` prefix. */
const PROVIDER_PINNED = /^[a-z0-9][a-z0-9._-]*\/[^/].*$/i;

export function isProviderPinnedModelId(id: string): boolean {
  return PROVIDER_PINNED.test(id);
}

/**
 * Returns one warning naming every bare id in the table, or nothing when the
 * table is fully pinned. One warning rather than one per model: a table of
 * twenty bare ids is a single decision about id discipline, not twenty.
 */
export function bareModelIdWarnings(ids: readonly string[]): string[] {
  const bare = ids.filter((id) => !isProviderPinnedModelId(id));
  if (bare.length === 0) return [];
  return [
    `${bare.length} model id(s) are bare and unprefixed: ${bare.join(", ")}. ` +
      "A bare id can resolve onto an unintended provider leg at the upstream instead of failing closed. " +
      "Prefer provider-pinned ids of the form provider/model.",
  ];
}
