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
# History: the config once carried two custom rules (`teamclaude-proxy-key`,
# `omniroute-credential`) with the capture group on the KEY NAME instead of the
# value, so `--redact` printed the credential, and with unanchored allowlist
# entries (TOG-227). PR #29 (0268b91) deleted both custom rules. This config is
# now the gitleaks default ruleset plus one anchored allowlist entry for a
# single fake UUID pointer kept in immutable test history — so the probes below
# assert default-ruleset properties, not the deleted custom rules (TOG-5343).
#
# Mutation-tested with gitleaks 8.21.2 (TOG-5367): setting `useDefault = false`
# fails the detection probes, deleting the allowlist entry fails the exemption
# probe, and unanchoring the allowlist regex fails the adjacency probes.
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

# Probe inputs are assembled from HALVES held separately, and only joined at
# runtime inside $WORK. Two reasons, both learned by getting it wrong:
#
#   - If this file contained a full credential pattern as a literal, the
#     repository scan would flag its own test data and the repository could
#     never be clean. Exempting the probes in the allowlist is not a way out:
#     the probes run under the same config, so exempting them makes them stop
#     firing and the self-test asserts nothing.
#   - Values must still LOOK like credentials. gitleaks' default allowlist
#     discards low-entropy matches such as a run of identical characters, so a
#     lazy `"AAAA…"` probe reports zero findings and reads as a broken rule.
#     The first draft of the TOG-227 self-test failed on exactly that, and the
#     rule was fine.
#
# Every half below is inert on its own: scanning a file of just the halves
# reports no leaks, so this script stays clean under the config it tests.
PEM_H1='-----BEGIN RSA PRIVATE'; PEM_H2=' KEY-----'
PEM_BODY='MIIBOgIBAAJBALRiMLAHjhirKpxV8+m836ZLG8RngBqYHcpqJ9kOkNaV8KQKBdQ'
PEM_T1='-----END RSA PRIVATE'; PEM_T2=' KEY-----'
GH_A='ghp_1234567890ab'; GH_B='cdefghij1234567890ABCDEF12'
XB_A='xoxb-123456789012-12'; XB_B='3456789012-abcdefghijklmnopqrstuvwx'
ST_A='sk_live_4eC39HqL'; ST_B='yjWDarjtT1zdp7dc'
V_GEN='9f3b21ccde77aa41bb02c4d5e6f70819'
V_UUID_OK='3f2504e0-4f89-41d3-9a0c-0305e82c3301'
V_UUID_OTHER='9a1b2c3d-4e5f-4061-8071-0a1b2c3d4e5f'
N_SVC='SERVICE_API_KEY'
N_PW='password'
N_REF='apiKeySecretRef'

echo "-- the default ruleset still detects"
probe "private-key block"      1 "$(printf '%s\n%s\n%s' "${PEM_H1}${PEM_H2}" "$PEM_BODY" "${PEM_T1}${PEM_T2}")"
probe "github personal token"  1 "${GH_A}${GH_B}"
probe "slack bot token"        1 "${XB_A}${XB_B}"
probe "stripe live key"        1 "${ST_A}${ST_B}"
probe "generic api key"        1 "$N_SVC = \"$V_GEN\""

echo "-- the allowlist exempts exactly the fixture, and nothing adjacent"
probe "the secret-ref uuid fixture"  0 "$N_REF: \"$V_UUID_OK\""
probe "a different uuid must fire"   1 "$N_PW = \"$V_UUID_OTHER\""
probe "fixture value + suffix fires" 1 "$N_PW = \"${V_UUID_OK}9f3b21ccde\""
probe "prefix + fixture value fires" 1 "$N_PW = \"X${V_UUID_OK}\""
probe "ordinary prose fires nothing" 0 "The router selects a lane based on capacity."

echo "-- --redact hides the VALUE, not the variable name"
# The defect this catches is not a count, so it is checked by reading the output.
CANARY='LEAKCANARY9f3b21cc'
printf '%s = "%s%s"\n' "$N_SVC" "$CANARY" "de77aa41bb02c4d5e6f70819" > "$WORK/probe.ts"
redacted="$("$GITLEAKS" dir "$WORK" --config "$WORK/.gitleaks.toml" --redact --no-banner --verbose 2>&1)"
rm -f "$WORK/probe.ts"
if printf '%s' "$redacted" | grep -q 'LEAKCANARY'; then
  failures=$((failures + 1))
  echo "FAIL  --redact printed the credential into the scan output"
else
  echo "PASS  --redact suppressed the credential value"
fi
if printf '%s' "$redacted" | grep -q "$N_SVC"; then
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
