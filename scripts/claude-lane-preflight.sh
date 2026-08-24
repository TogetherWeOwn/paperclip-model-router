#!/usr/bin/env bash
#
# Claude lane preflight — is it honest to set MODEL_ROUTER_CLAUDE_COMBO_ARMED=1?
#
# WHY THIS EXISTS (TOG-294)
#
# The plugin refuses to emit a bare Claude id — `claude-sonnet-5`, the
# provider-agnostic form owner rule 3 requires — unless the instance declares
# that OmniRoute has teamclaude Claude combos to resolve it. That declaration is
# an env var, which means it is an assertion, which means it can be wrong.
#
# It was wrong by default before this check existed. Measured on the live router:
#
#   - GET /api/v1/models returns 1,438 ids. ZERO are bare. `teamclaude/*` is EMPTY.
#   - POST /v1/messages {"model":"claude-sonnet-5"} nonetheless returned 200,
#     echoing "model": "anthropic/claude-sonnet-5" — an id that is ALSO absent
#     from the catalogue. Same for claude-opus-5 and claude-fable-5.
#
# So an unlisted bare Claude id does not fail closed at the router. It is
# silently rewritten onto a non-teamclaude Anthropic route and served. That is
# owner rule 1 broken by the exact id form owner rule 3 mandates. The plugin can
# only refuse to walk into it; it cannot fix the router. This script tells you
# whether the router has been fixed yet.
#
# THIS SCRIPT IS READ-ONLY AND SPENDS NOTHING.
#
# It issues exactly one GET against the model catalogue. It deliberately does
# NOT send a completion. TOG-294 was found because a verify script sent three
# live Claude completions off-teamclaude while the owner has that lane disabled
# — small spend, but spend on a route the owner said no to. A preflight whose
# job is to check that a lane is safe must not use the lane to find out.
#
# USAGE
#   OMNIROUTE_API_KEY=... scripts/claude-lane-preflight.sh [base-url]
#
# EXIT CODES
#   0  teamclaude/* is present — arming is supported by evidence.
#   1  teamclaude/* is empty — do NOT arm. Deploy TOG-153 first.
#   2  could not reach or parse the catalogue — unknown, so do not arm.

set -euo pipefail

BASE_URL="${1:-${OMNIROUTE_BASE_URL:-http://omniroute:20128}}"
BASE_URL="${BASE_URL%/}"

if [[ -z "${OMNIROUTE_API_KEY:-}" ]]; then
  echo "FAIL  OMNIROUTE_API_KEY is not set." >&2
  echo "      A routing-scope key is enough; this needs no management token." >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Claude lane preflight"
echo "  router: ${BASE_URL}"
echo "  method: one read-only GET /api/v1/models. No completion is sent."
echo

# The key is passed via the environment into curl's config file rather than on
# the command line, so it never appears in argv or in any process listing.
printf 'header = "Authorization: Bearer %s"\n' "${OMNIROUTE_API_KEY}" > "${WORK}/curlrc"
chmod 600 "${WORK}/curlrc"

http_code="$(
  curl --silent --show-error \
       --config "${WORK}/curlrc" \
       --max-time 30 \
       --output "${WORK}/models.json" \
       --write-out '%{http_code}' \
       "${BASE_URL}/api/v1/models" || echo "000"
)"

if [[ "${http_code}" != "200" ]]; then
  echo "FAIL  GET /api/v1/models returned HTTP ${http_code}."
  echo "      Cannot confirm the lane either way, so treat it as NOT armed."
  exit 2
fi

python3 - "${WORK}/models.json" <<'PY'
import json, sys

try:
    with open(sys.argv[1]) as handle:
        payload = json.load(handle)
except (OSError, ValueError) as error:
    print(f"FAIL  could not parse the catalogue: {error}")
    raise SystemExit(2)

entries = payload.get("data", payload if isinstance(payload, list) else [])
ids = [entry["id"] for entry in entries if isinstance(entry, dict) and "id" in entry]

if not ids:
    print("FAIL  the catalogue parsed but contains no model ids.")
    raise SystemExit(2)

teamclaude = sorted(i for i in ids if i.split("/", 1)[0].strip().lower() == "teamclaude")
bare = sorted(i for i in ids if "/" not in i)

print(f"  catalogue size      : {len(ids)} ids")
print(f"  bare (unprefixed)   : {len(bare)}")
print(f"  teamclaude/* routes : {len(teamclaude)}")
for entry in teamclaude[:10]:
    print(f"      {entry}")
if len(teamclaude) > 10:
    print(f"      ... and {len(teamclaude) - 10} more")
print()

if not teamclaude:
    print("RESULT  NOT ARMED — do not set MODEL_ROUTER_CLAUDE_COMBO_ARMED=1.")
    print()
    print("  teamclaude is not registered as an OmniRoute provider, so no combo")
    print("  can resolve a bare Claude id to it. Arming now would not create the")
    print("  route; it would only stop the plugin refusing to use one that does")
    print("  not exist — and the router will serve the id anyway, off teamclaude.")
    print()
    print("  Next step: TOG-153 (register teamclaude, then map the Claude combos).")
    raise SystemExit(1)

print("RESULT  ARMED IS SUPPORTED — teamclaude/* is present in the catalogue.")
print()
print("  This confirms the PROVIDER is registered. It does not by itself prove a")
print("  combo MAPPING sends a bare `claude-*` id to it — that mapping lives")
print("  behind the management token, so confirm it with the combo CLI (TOG-151)")
print("  or a management read before you rely on this for rule 1.")
raise SystemExit(0)
PY
