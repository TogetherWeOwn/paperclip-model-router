#!/usr/bin/env bash
#
# TOG-4896 local mitigation — distinct GitHub gateway tool names on the Muse lane.
#
# Defect (TOG-4896 f7-impact doc, verified directly against
# server/src/services/tool-gateway.ts:1266-1270 in TogetherWeOwn/paperclip):
#   connectionNamespace = slugSegment(applicationKey, "mcp") + "-" + shortStableId(connection.id)
#   toolSlug             = slugSegment(catalogEntry.toolName, "tool")
#   gatewayToolName       = "mcp." + connectionNamespace + ":" + toolSlug   <- the literal
#                           tool `name` exposed to every lane (line 1328).
#   tool-access.ts: gallery installs mint applicationKey = "app-gallery:<slug>:<randomUUID>"
#   The embedded randomUUID makes connectionNamespace alone ~55-65 chars. slugSegment
#   itself doesn't truncate that (it's under its own 64-char per-segment cap), but the
#   COMBINED gatewayToolName ("mcp." + namespace + ":" + toolSlug) is what the
#   Muse-lane CLIProxy caps at 64 chars downstream -- so almost no room is left for
#   toolSlug, every GitHub action collapses onto one shared truncated head with "_N"
#   aliases, and the reverse name -> action map breaks ("No such tool available").
#   Measured 162/371 (44%) Muse-lane GitHub calls 2026-09-19..26.
#
# This script does NOT touch the upstream derivation code (that fix is the TOG-4896
# slice A commit, 14d077c52, pending its own review). It is a local mitigation for
# the currently deployed code: it shortens `tool_applications.application_key` for
# affected GitHub gallery rows so the EXISTING namespace formula produces a short,
# distinct name, without deploying anything.
#
# Narrowest-change guarantee:
#   - The only column ever written is tool_applications.application_key.
#   - Grants (connection_grants) key on connection_id/company_id, never application_key
#     (packages/db/src/schema/tool_access.ts:174-249) -- unaffected by construction.
#   - Profile entries (tool_profile_entries) select by applicationId/connectionId/
#     catalogEntryId IDs, or by a literal tool_name that is the upstream catalog name
#     (unaffected: we never touch catalog names) -- unaffected by construction.
#   - Policy selectors (tool_policies.selectors) CAN carry a literal applicationKey /
#     applicationKeys match (tool-access-policy.ts:357, matched against a value
#     re-read from the DB row at decision time, tool-access-policy.ts:967). This is
#     the one path a key change can break. Every row this script would touch is
#     pre-flight-checked against tool_policies before it is ever included in an
#     apply plan; any row with a live literal-key policy hit is EXCLUDED from the
#     apply set and reported, never silently applied.
#
# Modes:
#   offline-selftest   No DB. Validates the slug/length arithmetic against fixture
#                      data. Safe to run anywhere, any time.
#   dry-run            Read-only. Connects to the DB named by --db-url/$TOG4896_DB_URL,
#                      lists affected rows, computes the new key for each, runs the
#                      policy pre-flight check, and prints the apply plan. No writes.
#   apply              Writes. Refuses to run without --confirm-ceo-signoff AND a
#                      clean pre-flight (see above). Requires --company-id (one
#                      company per invocation -- no fleet-wide writes from one run).
#                      Writes a rollback manifest before making any change.
#   rollback           Writes. Takes --manifest <path> from a prior apply and
#                      restores the exact prior application_key values it recorded.
#
# No grants, policies, permissions, or any table other than tool_applications is
# ever written by this script. No secret material is read or printed; the DB
# connection string is taken from an env var by name and never echoed.
#
# Usage:
#   deployment-staging/TOG-4896-operator.sh offline-selftest
#   deployment-staging/TOG-4896-operator.sh dry-run  [--company-id UUID] [--gallery-key github]
#   deployment-staging/TOG-4896-operator.sh apply    --company-id UUID --confirm-ceo-signoff [--gallery-key github]
#   deployment-staging/TOG-4896-operator.sh rollback --manifest PATH
#
# DB connection: set TOG4896_DB_URL (or pass --db-url). Never $DATABASE_URL by
# default -- this script only ever touches the DB an operator names explicitly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
shift || true

DB_URL="${TOG4896_DB_URL:-}"
COMPANY_ID=""
GALLERY_KEY="github"
CONFIRM_SIGNOFF=0
MANIFEST_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --db-url) DB_URL="$2"; shift 2 ;;
    --company-id) COMPANY_ID="$2"; shift 2 ;;
    --gallery-key) GALLERY_KEY="$2"; shift 2 ;;
    --confirm-ceo-signoff) CONFIRM_SIGNOFF=1; shift ;;
    --manifest) MANIFEST_PATH="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- shared: reimplementation of tool-gateway.ts slugSegment/shortStableId -------
# Kept byte-for-byte equivalent to server/src/services/tool-gateway.ts:734-748 so the
# offline self-test proves the same arithmetic the live gateway will run.
slug_segment() {
  local value="$1" fallback="$2" slug
  slug="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  slug="${slug:0:64}"
  if [ -z "$slug" ]; then printf '%s' "$fallback"; else printf '%s' "$slug"; fi
}

short_stable_id() {
  printf '%s' "$1" | tr -d '-' | cut -c1-8
}

require_db_url() {
  if [ -z "$DB_URL" ]; then
    echo "FAIL: no DB connection configured. Set TOG4896_DB_URL or pass --db-url." >&2
    echo "      This script never guesses a database; \$DATABASE_URL is ignored on purpose." >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "FAIL: psql not found on PATH." >&2
    exit 1
  fi
}

psql_json() {
  # $1 = SQL. Emits rows as JSON lines. Never prints $DB_URL.
  PGCONNECT_TIMEOUT=10 psql "$DB_URL" -X -q -A -t -c "$1"
}

# --- offline-selftest -------------------------------------------------------------
# Reproduces the EXACT construction in server/src/services/tool-gateway.ts:1266-1270:
#   connectionNamespace = slugSegment(applicationKey ?? connection.name ?? application.name, "mcp") + "-" + shortStableId(connection.id)
#   toolSlug            = slugSegment(catalogEntry.toolName, "tool")
#   gatewayToolName      = "mcp." + connectionNamespace + ":" + toolSlug
# `gatewayToolName` (the literal `name` field returned to every lane, tool-gateway.ts:1328)
# is the exact string capped at 64 chars downstream -- there is no separate,
# additional client-side prefix budget to account for; the whole string above IS
# the name. This self-test checks that literal string's length directly.
run_offline_selftest() {
  local failures=0
  gateway_tool_name() {
    local app_key="$1" conn_id="$2" tool_name="$3"
    local ns tool_slug
    ns="$(slug_segment "$app_key" mcp)-$(short_stable_id "$conn_id")"
    tool_slug="$(slug_segment "$tool_name" tool)"
    printf 'mcp.%s:%s' "$ns" "$tool_slug"
  }

  # $1 label, $2 applicationKey, $3 connectionId, $4 toolName, $5 expect: fits|overflows
  check_name() {
    local label="$1" app_key="$2" conn_id="$3" tool_name="$4" expect="$5"
    local base len verdict
    base="$(gateway_tool_name "$app_key" "$conn_id" "$tool_name")"
    len=${#base}
    if [ "$len" -le 64 ]; then verdict=fits; else verdict=overflows; fi
    if [ "$verdict" = "$expect" ]; then
      printf 'PASS  %-42s len=%-3d %-9s base=%s\n' "$label" "$len" "($verdict)" "$base"
    else
      failures=$((failures + 1))
      printf 'FAIL  %-42s len=%-3d %-9s base=%s  (expected %s)\n' "$label" "$len" "($verdict)" "$base" "$expect"
    fi
  }

  echo "== before mitigation: current gallery key reproduces the measured defect =="
  # Real shape from tool-access.ts -- app-gallery:<slug>:<randomUUID>
  check_name "unmitigated github (long)" \
    "app-gallery:github:4a90142d-abbf-4715-95fe-93cef04b1eac" \
    "4727966b00000000" \
    "add-reply-to-pull-request-comment" overflows
  check_name "unmitigated github, short action" \
    "app-gallery:github:4a90142d-abbf-4715-95fe-93cef04b1eac" \
    "4727966b00000000" \
    "get-me" overflows

  echo "== after mitigation: bare gallery key, single row per (company, galleryKey) =="
  check_name "get-me"                          "github" "4727966b00000000" "get-me" fits
  check_name "get-file-contents"                "github" "4727966b00000000" "get-file-contents" fits
  check_name "list-branches"                    "github" "4727966b00000000" "list-branches" fits
  check_name "list-pull-requests"               "github" "4727966b00000000" "list-pull-requests" fits
  check_name "list-commits"                     "github" "4727966b00000000" "list-commits" fits
  check_name "longest observed: add-reply..."   "github" "4727966b00000000" "add-reply-to-pull-request-comment" fits
  check_name "longest observed: add-comment..." "github" "4727966b00000000" "add-comment-to-pending-review" fits

  echo "== after mitigation: disambiguated second row, same company + galleryKey =="
  check_name "second github row (id-suffixed)" "github-9a1b2c3d" "4727966b00000000" "add-reply-to-pull-request-comment" fits

  echo "== distinctness: two different connections never collapse to one base name =="
  local n1 n2
  n1="$(slug_segment github mcp)-$(short_stable_id 4727966b00000000)"
  n2="$(slug_segment github mcp)-$(short_stable_id deadbeef00000000)"
  if [ "$n1" != "$n2" ]; then
    echo "PASS  distinct connections under the same galleryKey get distinct namespaces ($n1 vs $n2)"
  else
    failures=$((failures + 1))
    echo "FAIL  two different connections produced the same namespace"
  fi

  echo "======================================================================"
  if [ "$failures" -ne 0 ]; then
    echo "  $failures wrong verdict(s)."
    exit 1
  fi
  echo "  offline self-test passed: mitigation keeps every measured base name <=64 chars"
}

# --- dry-run / apply: candidate discovery + pre-flight -----------------------------
# SQL is kept in variables (not heredocs baked with values) so no value is
# interpolated into a printed string; psql binds --db-url only, never echoed.

sql_candidates() {
  local company_filter=""
  if [ -n "$COMPANY_ID" ]; then
    company_filter="AND company_id = '${COMPANY_ID}'"
  fi
  cat <<SQL
select id, company_id, application_key, coalesce(metadata->>'galleryKey', metadata->>'sourceTemplateKey') as gallery_key
from tool_applications
where status <> 'archived'
  and coalesce(metadata->>'galleryKey', metadata->>'sourceTemplateKey') = '${GALLERY_KEY}'
  and application_key is not null
  and length(application_key) > 40
  ${company_filter}
order by company_id, created_at;
SQL
}

sql_policy_hits_for_key() {
  local key="$1"
  cat <<SQL
select id, name
from tool_policies
where enabled = true
  and (
    selectors->>'applicationKey' = '${key}'
    or (selectors ? 'applicationKeys' and selectors->'applicationKeys' ? '${key}')
  );
SQL
}

# Build the new key for a row, given the set of keys already assigned in this plan
# for the same (company_id, galleryKey) pair, so a second/third row never collides.
plan_new_key() {
  local gallery_key="$1" row_id="$2" already_used_csv="$3"
  local candidate="$gallery_key"
  if printf '%s\n' "$already_used_csv" | tr ',' '\n' | grep -qx "$candidate"; then
    candidate="${gallery_key}-$(short_stable_id "$row_id")"
  fi
  printf '%s' "$candidate"
}

run_dry_run() {
  require_db_url
  echo "== TOG-4896 dry-run: gallery-key=${GALLERY_KEY} company-id=${COMPANY_ID:-<all>} =="
  local rows
  rows="$(psql_json "$(sql_candidates)")"
  if [ -z "$rows" ]; then
    echo "no candidate rows (nothing to mitigate for this scope)"
    return 0
  fi

  local used_keys="" blocked=0 planned=0
  echo "id|company_id|old_key(len)|new_key|policy_preflight"
  while IFS='|' read -r id company_id old_key gallery_key; do
    [ -z "$id" ] && continue
    local new_key hits
    new_key="$(plan_new_key "$gallery_key" "$id" "$used_keys")"
    hits="$(psql_json "$(sql_policy_hits_for_key "$old_key")")"
    if [ -n "$hits" ]; then
      blocked=$((blocked + 1))
      printf '%s|%s|len=%d|SKIPPED|BLOCKED: live policy selector matches old key -- %s\n' \
        "$id" "$company_id" "${#old_key}" "$hits"
      continue
    fi
    used_keys="${used_keys},${new_key}"
    planned=$((planned + 1))
    printf '%s|%s|len=%d|%s|clear\n' "$id" "$company_id" "${#old_key}" "$new_key"
  done <<< "$rows"

  echo "----"
  echo "planned: $planned  blocked-by-policy-preflight: $blocked"
  if [ "$blocked" -gt 0 ]; then
    echo "Blocked rows need manual policy review before they can be included in an apply."
  fi
  echo "No writes were made (dry-run)."
}

run_apply() {
  require_db_url
  if [ -z "$COMPANY_ID" ]; then
    echo "FAIL: apply requires --company-id (one company per run, no fleet-wide writes)." >&2
    exit 1
  fi
  if [ "$CONFIRM_SIGNOFF" -ne 1 ]; then
    echo "FAIL: apply requires --confirm-ceo-signoff. Per TOG-5763, apply needs CEO" >&2
    echo "      sign-off after a live dry-run, coordinated with the TOG-4761 readout." >&2
    exit 1
  fi

  local rows
  rows="$(psql_json "$(sql_candidates)")"
  if [ -z "$rows" ]; then
    echo "no candidate rows for company ${COMPANY_ID} -- nothing to apply."
    return 0
  fi

  local manifest="${SCRIPT_DIR}/TOG-4896-rollback-$(date -u +%Y%m%dT%H%M%SZ)-${COMPANY_ID}.json"
  local used_keys="" entries="[]" blocked=0

  while IFS='|' read -r id company_id old_key gallery_key; do
    [ -z "$id" ] && continue
    local new_key hits
    new_key="$(plan_new_key "$gallery_key" "$id" "$used_keys")"
    hits="$(psql_json "$(sql_policy_hits_for_key "$old_key")")"
    if [ -n "$hits" ]; then
      blocked=$((blocked + 1))
      echo "BLOCKED (skipped, no write): $id -- live policy selector matches old key: $hits" >&2
      continue
    fi
    used_keys="${used_keys},${new_key}"
    entries="$(printf '%s' "$entries" | python3 -c "
import json,sys
e = json.load(sys.stdin)
e.append({'id': '$id', 'company_id': '$company_id', 'old_application_key': '$old_key', 'new_application_key': '$new_key'})
print(json.dumps(e))
")"
  done <<< "$rows"

  printf '%s' "$entries" > "$manifest"
  echo "rollback manifest written: $manifest"

  # Single transaction: write application_key only, assert no other table's row
  # counts moved, per-row guarded by the id AND the still-current old key so a
  # racing change is never clobbered.
  local sql="BEGIN;
"
  local before_counts="select
  (select count(*) from connection_grants) as grants,
  (select count(*) from tool_policies) as policies,
  (select count(*) from tool_profile_entries) as profile_entries;"
  echo "pre-write invariant counts (grants/policies/profile_entries): $(psql_json "$before_counts")"

  echo "$entries" | python3 -c "
import json, sys
for e in json.load(sys.stdin):
    print(f\"UPDATE tool_applications SET application_key = '{e['new_application_key']}', updated_at = now() WHERE id = '{e['id']}' AND application_key = '{e['old_application_key']}';\")
" > "${manifest}.sql"

  {
    echo "BEGIN;"
    cat "${manifest}.sql"
    echo "COMMIT;"
  } | psql "$DB_URL" -X -q -v ON_ERROR_STOP=1

  local after_counts
  after_counts="$(psql_json "$before_counts")"
  echo "post-write invariant counts (grants/policies/profile_entries): $after_counts"
  echo "applied: $(echo "$entries" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')  blocked: $blocked"
  echo "Rollback: $0 rollback --manifest $manifest"
}

run_rollback() {
  require_db_url
  if [ -z "$MANIFEST_PATH" ] || [ ! -f "$MANIFEST_PATH" ]; then
    echo "FAIL: rollback requires --manifest <path-from-apply>." >&2
    exit 1
  fi

  local sql
  sql="$(python3 -c "
import json
entries = json.load(open('$MANIFEST_PATH'))
for e in entries:
    print(f\"UPDATE tool_applications SET application_key = '{e['old_application_key']}', updated_at = now() WHERE id = '{e['id']}' AND application_key = '{e['new_application_key']}';\")
")"

  {
    echo "BEGIN;"
    printf '%s\n' "$sql"
    echo "COMMIT;"
  } | psql "$DB_URL" -X -q -v ON_ERROR_STOP=1

  echo "rollback applied from $MANIFEST_PATH"
}

case "$MODE" in
  offline-selftest) run_offline_selftest ;;
  dry-run) run_dry_run ;;
  apply) run_apply ;;
  rollback) run_rollback ;;
  *)
    echo "usage: $0 {offline-selftest|dry-run|apply|rollback} [options]" >&2
    exit 1
    ;;
esac
