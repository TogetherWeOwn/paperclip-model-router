#!/usr/bin/env bash
# TOG-5751 smoke: model-router post-public hosted-CI check.
#
# Re-runnable by any reviewer with `gh` authenticated (read-only; no spend,
# no credentials written anywhere):
#
#   bash scripts/tog-5751-post-public-smoke.sh [owner/repo]
#
# Asserts, against origin/main's default SHA:
#   1. repo visibility is public (authed API + unauthenticated REST cross-check)
#   2. a completed CI run exists on the default SHA and concluded success
#   3. every job in that run executed on GitHub-hosted runners (no self-hosted)
#   4. the checked-out tree pins no self-hosted runner labels in .github/workflows
#   5. MIT LICENSE is present
#   6. zero tracked tenant-marker hits outside docs/operator reference docs
#   7. no PR exposure vectors (pull_request_target / workflow_run / secrets.)
#   8. the secret-scan job in the pinned run concluded success
#
# Each step prints exactly one `STEP <name>: PASS|FAIL|SKIP` line. Exit code
# is the FAIL count (0 = smoke passes). The 7-day consumer is TOG-5541.
set -u -o pipefail

REPO="${1:-TogetherWeOwn/paperclip-model-router}"
FAIL=0
GREEN_SHA=""
GREEN_RUN=""

step() { # name verdict detail
  printf 'STEP %s: %s - %s\n' "$1" "$2" "$3"
  [ "$2" = "FAIL" ] && FAIL=$((FAIL + 1))
  return 0
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    step "prereq-$1" "FAIL" "binary '$1' not found on PATH"
    echo "RESULT: cannot run (missing $1)"
    exit 1
  }
}

need gh
need git
need curl

echo "repo: $REPO"
echo "date (UTC): $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# 1. visibility: public -------------------------------------------------------
VIS_LINE="$(gh api "repos/$REPO" --jq '"\(.private)|\(.visibility)"' 2>/dev/null || echo MISSING)"
if [ "$VIS_LINE" = "MISSING" ] || [ -z "$VIS_LINE" ]; then
  step "visibility" "FAIL" "authed repos API call failed (gh auth?)"
else
  PRIV="${VIS_LINE%%|*}"
  VIS="${VIS_LINE##*|}"
  HTTP="$(curl -s -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$REPO")"
  if [ "$PRIV" = "false" ] && [ "$VIS" = "public" ] && [ "$HTTP" = "200" ]; then
    step "visibility" "PASS" "private=false visibility=public, unauth REST=$HTTP"
  else
    step "visibility" "FAIL" "authed=($PRIV/$VIS) unauth-REST=$HTTP (want false/public + 200)"
  fi
fi

# 2+3. green CI run on the default SHA, all jobs hosted ------------------------
DEFAULT_SHA="$(git ls-remote origin HEAD 2>/dev/null | cut -f1)"
[ -n "$DEFAULT_SHA" ] && DEFAULT_SHA7="${DEFAULT_SHA:0:7}" || DEFAULT_SHA7="unknown"
if [ -z "$DEFAULT_SHA" ]; then
  step "ci-green-on-default-sha" "FAIL" "could not resolve origin/HEAD"
  step "ci-hosted-runners" "SKIP" "no default SHA"
else
  RUN_TSV="$(gh api "repos/$REPO/actions/workflows/340755426/runs?branch=main&per_page=10" \
    --jq "[.workflow_runs[] | select(.head_sha==\"$DEFAULT_SHA\")][0] | select(. != null) | \"\(.id)\t\(.status)\t\(.conclusion // \"null\")\t\(.html_url)\"" 2>/dev/null || true)"
  # Fall back to workflow-agnostic listing if the CI workflow id ever changes.
  if [ -z "$RUN_TSV" ]; then
    RUN_TSV="$(gh api "repos/$REPO/actions/runs?branch=main&per_page=10" \
      --jq "[.workflow_runs[] | select(.head_sha==\"$DEFAULT_SHA\" and .name==\"CI\")][0] | select(. != null) | \"\(.id)\t\(.status)\t\(.conclusion // \"null\")\t\(.html_url)\"" 2>/dev/null || true)"
  fi
  if [ -z "$RUN_TSV" ]; then
    step "ci-green-on-default-sha" "FAIL" "no CI run found for default SHA $DEFAULT_SHA7"
    step "ci-hosted-runners" "SKIP" "no CI run to inspect"
    step "secret-scan-green" "SKIP" "no CI run to inspect"
  else
    RUN_ID="$(printf '%s' "$RUN_TSV" | cut -f1)"
    STATUS="$(printf '%s' "$RUN_TSV" | cut -f2)"
    CONCL="$(printf '%s' "$RUN_TSV" | cut -f3)"
    RUN_URL="$(printf '%s' "$RUN_TSV" | cut -f4)"
    # Self-validation: the run id must be numeric AND re-fetching it by id
    # must return the default SHA. Guards against list/parse drift binding
    # the verdict to the wrong run.
    BIND="$(gh api "repos/$REPO/actions/runs/$RUN_ID" \
      --jq '"\(.head_sha)|\(.status)|\(.conclusion // "null")"' 2>/dev/null || echo MISSING)"
    if ! printf '%s' "$RUN_ID" | grep -qE '^[0-9]+$'; then
      step "ci-green-on-default-sha" "FAIL" "run binding invalid: id='$RUN_ID' is not numeric"
      step "ci-hosted-runners" "SKIP" "run binding invalid"
      step "secret-scan-green" "SKIP" "run binding invalid"
    elif [ "$BIND" = "MISSING" ]; then
      step "ci-green-on-default-sha" "FAIL" "run $RUN_ID listed but re-fetch by id failed"
      step "ci-hosted-runners" "SKIP" "run re-fetch failed"
      step "secret-scan-green" "SKIP" "run re-fetch failed"
    elif [ "${BIND%%|*}" != "$DEFAULT_SHA" ]; then
      step "ci-green-on-default-sha" "FAIL" "run $RUN_ID re-fetch head ${BIND%%|*} != default SHA $DEFAULT_SHA7 (list/parse drift)"
      step "ci-hosted-runners" "SKIP" "run binding drifted"
      step "secret-scan-green" "SKIP" "run binding drifted"
    else
      RUN_URL="https://github.com/$REPO/actions/runs/$RUN_ID"
    if [ "$STATUS" = "completed" ] && [ "$CONCL" = "success" ]; then
      GREEN_SHA="$DEFAULT_SHA7"
      GREEN_RUN="$RUN_ID"
      step "ci-green-on-default-sha" "PASS" "run $RUN_ID on $DEFAULT_SHA7 completed/success ($RUN_URL)"
    else
      step "ci-green-on-default-sha" "FAIL" "run $RUN_ID on $DEFAULT_SHA7 is $STATUS/$CONCL, want completed/success ($RUN_URL)"
    fi
    if [ -n "$RUN_ID" ]; then
      JOBS_RAW="$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" 2>/dev/null || echo MISSING)"
      # A 404/403 error envelope is JSON without .jobs — never let it masquerade
      # as job rows. Parse only when the envelope carries a jobs array.
      if [ "$JOBS_RAW" = "MISSING" ] || ! printf '%s' "$JOBS_RAW" | grep -q '"jobs"'; then
        step "ci-hosted-runners" "FAIL" "could not list jobs for run $RUN_ID (jobs API: $(printf '%s' "$JOBS_RAW" | head -c 160))"
        JOBS=""
      else
        JOBS="$(printf '%s' "$JOBS_RAW" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for j in d.get('jobs',[]):
  print('%s|%s|%s|%s' % (j['name'], j['status'], j.get('conclusion') or 'null', ','.join(j.get('labels',[]))))
" 2>/dev/null || true)"
        if [ -z "$JOBS" ]; then
          step "ci-hosted-runners" "FAIL" "run $RUN_ID returned zero job rows"
        fi
      fi
      if [ -z "${JOBS:-}" ]; then
        : # verdict already recorded above
        step "secret-scan-green" "SKIP" "jobs list unavailable for run $RUN_ID"
      else
        if printf '%s\n' "$JOBS" | grep -qi 'self-hosted'; then
          step "ci-hosted-runners" "FAIL" "run $RUN_ID used self-hosted labels: $(printf '%s' "$JOBS" | tr '\n' '; ')"
        else
          BAD="$(printf '%s\n' "$JOBS" | grep -v '|completed|success|' || true)"
          if [ -n "$BAD" ]; then
            step "ci-hosted-runners" "FAIL" "non-success jobs in run $RUN_ID: $(printf '%s' "$BAD" | tr '\n' '; ')"
          else
            step "ci-hosted-runners" "PASS" "run $RUN_ID: all jobs completed/success, labels=[$(printf '%s' "$JOBS" | cut -d'|' -f4 | sort -u | tr '\n' ',' | sed 's/,$//')]"
          fi
        fi
        SCAN="$(printf '%s\n' "$JOBS" | grep -i '^secret scan|' || true)"
        if [ -z "$SCAN" ]; then
          step "secret-scan-green" "FAIL" "no 'secret scan' job in run $RUN_ID"
        elif printf '%s' "$SCAN" | grep -q '|completed|success|'; then
          step "secret-scan-green" "PASS" "run $RUN_ID secret scan completed/success"
        else
          step "secret-scan-green" "FAIL" "run $RUN_ID secret scan: $SCAN"
        fi
      fi
    else
      step "ci-hosted-runners" "SKIP" "no run id parsed"
      step "secret-scan-green" "SKIP" "no run id parsed"
    fi
    fi # end bound-run branch (if/elif/elif/else on BIND)
  fi
fi

# 4. checked-out tree pins no self-hosted labels -------------------------------
# Comment lines are excluded: ci.yml documents WHY persistent self-hosted
# runners needed run-unique unpack dirs (TOG-2941) — prose about the label
# is not a `runs-on:` pin. Only actual runner specifications count.
if [ -d .github/workflows ]; then
  SELFHOSTED="$(grep -rn 'self-hosted' .github/workflows/ | grep -vE '^\s*#' | grep -vE ':[0-9]+:\s*#' || true)"
  if [ -z "$SELFHOSTED" ]; then
    step "workflows-hosted-only" "PASS" ".github/workflows has no self-hosted labels"
  else
    step "workflows-hosted-only" "FAIL" "self-hosted still pinned: $(printf '%s' "$SELFHOSTED" | tr '\n' '; ')"
  fi
else
  step "workflows-hosted-only" "FAIL" ".github/workflows missing (run from repo root)"
fi

# 5. MIT LICENSE ---------------------------------------------------------------
if [ -f LICENSE ] && head -1 LICENSE | grep -q 'MIT License'; then
  step "license-mit" "PASS" "LICENSE present, MIT header"
else
  step "license-mit" "FAIL" "LICENSE missing or not MIT"
fi

# 6. tracked tenant markers (company/tenant ids, internal host) ----------------
# docs/operator/*.patch|*.md are reference/queued-patch records, graded by
# scripts/check-workflows.mjs gate 1 — not live tree claims.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  HITS="$(git grep -InE 'ef993a7e|infextion|two-isolated' -- . ':!docs/operator' 2>/dev/null || true)"
  if [ -z "$HITS" ]; then
    step "tracked-markers" "PASS" "zero tenant-marker hits outside docs/operator"
  else
    step "tracked-markers" "FAIL" "hits: $(printf '%s' "$HITS" | tr '\n' '; ')"
  fi
else
  step "tracked-markers" "SKIP" "not inside a git work tree"
fi

# 7. PR exposure vectors --------------------------------------------------------
if [ -d .github/workflows ]; then
  EXPOSED="$(grep -rnE 'pull_request_target|workflow_run|secrets\.' .github/workflows/ || true)"
  if [ -z "$EXPOSED" ]; then
    step "pr-exposure-vectors" "PASS" "no pull_request_target/workflow_run/secrets. in workflows"
  else
    step "pr-exposure-vectors" "FAIL" "exposed: $(printf '%s' "$EXPOSED" | tr '\n' '; ')"
  fi
fi

echo "RESULT: $FAIL failing step(s) (default SHA ${DEFAULT_SHA7:-unresolved}, green run ${GREEN_RUN:-none})"
exit "$FAIL"
