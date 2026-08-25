#!/usr/bin/env bash
#
# Test the secret scanner itself.
#
# `gitleaks dir .` proves this repository is clean *under the current config*.
# It says nothing about whether the config still detects anything — a rule can
# be silently defanged by an edit to its regex or by an allowlist entry that is
# broader than it looks, and the scan stays green either way. Green is exactly
# what a broken scanner looks like.
#
# Two defects found in this config on 2026-08-25 (TOG-227), both invisible to a
# clean scan:
#
#   1. The capture group was on the KEY NAME, not the value. gitleaks reports
#      group 1 as "the secret", so `--redact` replaced the word `ANTHROPIC` and
#      printed the key: `ANTHROPIC_API_KEY = "sk-ant-api03-…"` rendered in the
#      CI log as `REDACTED_API_KEY = "sk-ant-api03-…"`. The scanner published
#      the credential it existed to catch, on the one path that only executes
#      when a real key is present.
#
#   2. Allowlist entries were unanchored, so the fixture exemption
#      `sk-live-not-a-reference` also exempted `sk-live-not-a-reference<key>`.
#
#   3. `omniroute-credential`'s value class was `\S`, which swallowed the
#      closing quote and comma — so the "secret" was `sk-…",` and no anchored
#      allowlist entry could ever match it.
#
# Each is one line away from returning, so the properties are asserted here,
# next to the config, and run in the same CI job as the scan. Mutation-tested:
# restoring (1) fails 3 assertions, (2) fails 1, (3) fails 1.
#
# Usage:  scripts/gitleaks-selftest.sh [path-to-gitleaks]
# Exits non-zero on any wrong verdict.

set -uo pipefail

GITLEAKS="${1:-gitleaks}"
CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.gitleaks.toml"

if ! command -v "$GITLEAKS" >/dev/null 2>&1 && [ ! -x "$GITLEAKS" ]; then
  echo "FAIL  gitleaks not found at '$GITLEAKS'"
  echo "      This script must not be skipped silently: pass the binary path as \$1."
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$CONFIG" "$WORK/.gitleaks.toml"

failures=0

# $1 label, $2 expected finding count, $3 file content
probe() {
  local label="$1" want="$2" content="$3"
  printf '%s\n' "$content" > "$WORK/probe.ts"
  local out got
  out="$("$GITLEAKS" dir "$WORK" --config "$WORK/.gitleaks.toml" --redact --no-banner 2>&1)"
  got="$(printf '%s' "$out" | grep -oE 'leaks found: [0-9]+' | grep -oE '[0-9]+' | tail -1)"
  got="${got:-0}"
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-52s %s finding(s)\n' "$label" "$got"
  else
    failures=$((failures + 1))
    printf 'FAIL  %-52s got %s, want %s\n' "$label" "$got" "$want"
  fi
  rm -f "$WORK/probe.ts"
}

echo "======================================================================"
echo "SECRET SCANNER SELF-TEST — $CONFIG"
echo "======================================================================"

# Probe inputs are assembled from a NAME and a VALUE held separately, and only
# joined at runtime inside $WORK. Two reasons, both learned by getting it wrong:
#
#   - If this file contained `ANTHROPIC_API_KEY = "sk-ant-…"` as a literal, the
#     scanner would flag its own test data and the repository could never be
#     clean. Exempting the probes in the allowlist is not a way out: the probes
#     run under the same config, so exempting them makes them stop firing and
#     the self-test asserts nothing.
#   - Values must still LOOK like credentials. gitleaks' default allowlist
#     (`useDefault = true`) discards low-entropy matches such as a run of
#     identical characters, so a lazy `"AAAA…"` probe reports zero findings and
#     reads as a broken rule. The first draft of this file failed on exactly
#     that, and the rule was fine.
N_ANTHROPIC='ANTHROPIC_API'; N_ANTHROPIC="${N_ANTHROPIC}_KEY"
N_TEAMCLAUDE='teamclaude_api'; N_TEAMCLAUDE="${N_TEAMCLAUDE}_key"
N_OMNI='OMNIROUTE_API'; N_OMNI="${N_OMNI}_KEY"
N_OMNIPW='omniroute'; N_OMNIPW="${N_OMNIPW}_password"
N_REF='apiKeySecretRef'

V_ANT='sk-ant-api03-9f3b21ccde77aa41bb02'
V_TC='tc_9f3b21ccde77aa41bb02'
V_OMA='oma_live_9f3b21ccde'
V_PW='Xk7pQ2mv91ZbnR4t'
V_FIXTURE='sk-not-a-real-key'
V_UUID_OK='3f2504e0-4f89-41d3-9a0c-0305e82c3301'
V_UUID_OTHER='9a1b2c3d-4e5f-4061-8071-0a1b2c3d4e5f'

echo "-- the rules still detect"
probe "real-looking anthropic key"        1 "$N_ANTHROPIC = \"$V_ANT\""
probe "real-looking teamclaude key"       1 "$N_TEAMCLAUDE: \"$V_TC\""
probe "real-looking omniroute key"        1 "$N_OMNI: \"$V_OMA\","
probe "omniroute management password"     1 "$N_OMNIPW = \"$V_PW\""

echo "-- the allowlist exempts exactly the fixtures, and nothing adjacent"
probe "the preflight-spec fixture"        0 "$N_OMNI: \"$V_FIXTURE\","
probe "fixture value + suffix must fire"  1 "$N_OMNI: \"${V_FIXTURE}9f3b21ccde\","
probe "the secret-ref uuid fixture"       0 "$N_REF: \"$V_UUID_OK\""
probe "a different uuid must fire"        1 "$N_OMNI: \"$V_UUID_OTHER\""

echo "-- --redact hides the VALUE, not the variable name"
# The defect this catches is not a count, so it is checked by reading the output.
CANARY='LEAKCANARY9f3b21cc'
printf '%s = "sk-ant-api03-%s"\n' "$N_ANTHROPIC" "$CANARY" > "$WORK/probe.ts"
redacted="$("$GITLEAKS" dir "$WORK" --config "$WORK/.gitleaks.toml" --redact --no-banner --verbose 2>&1)"
rm -f "$WORK/probe.ts"
if printf '%s' "$redacted" | grep -q 'LEAKCANARY'; then
  failures=$((failures + 1))
  echo "FAIL  --redact printed the credential into the scan output"
  echo "      The capture group is on the key name again. gitleaks redacts group 1;"
  echo "      put the group around the VALUE. See the comment in .gitleaks.toml."
else
  echo "PASS  --redact suppressed the credential value"
fi
if printf '%s' "$redacted" | grep -q "$N_ANTHROPIC"; then
  echo "PASS  --redact left the variable name visible, so the finding is actionable"
else
  failures=$((failures + 1))
  echo "FAIL  --redact hid the variable name — the finding names no location"
fi

echo "======================================================================"
if [ "$failures" -ne 0 ]; then
  echo "  $failures wrong verdict(s) — the secret scanner is not doing its job."
  exit 1
fi
echo "  secret scanner self-test passed"
