#!/usr/bin/env python3
"""Compare the Muse reasoning-replay canary arm with its control from Paperclip run records (TOG-12934).

Reads `GET /api/companies/<id>/heartbeat-runs?agentId=<id>` for every agent (newest first, at most 1000
rows per call; the company-wide call ignores offset and time filters), so it runs from an agent container
with no database access. It needs only PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID, or a
saved JSON dump (`--from-file`).

Arms are decided by the model the run actually used (`usageJson.model`, reasoning-effort suffix such as
`(xhigh)` stripped), never by what a pin or agent config says. A run counts as:

  canary   model starts with one of --canary-model   (default: muse-canary)
  control  model starts with one of --control-model  (default: muse-spark-1.3-contributor)

Missing-disposition proxy. The platform has no per-run "missing disposition" field. When a succeeded run
leaves a card without a valid disposition, Paperclip queues a follow-up wake. Two wake reasons exist:

  finish_successful_run_handoff   the missing-disposition follow-up. HEADLINE metric. No link to the run
                                  that caused it, so it is attributed to the same agent's latest earlier
                                  succeeded run on the same issue
  issue_continuation_needed       a broader "this card still has work" wake; its follow-up run's
                                  retryOfRunId names the run that caused it. Reported as context only

Each follow-up is counted against the model of the run that CAUSED it. Calibration, measured 2026-10-03
over the 2026-10-02 UTC day, all models, 4,419 succeeded runs (two agents hit the 1000-row cap, so the
numbers are slightly low): 306 handoff follow-ups = 6.9 per 100, against the operator's baseline of 352
notices per 5,662 runs = 6.2 per 100, so the magnitude agrees; I did not reconcile the windows run for
run. issue_continuation_needed was 22.0 per 100, far above the baseline's 4.0 parks per 100, so it is
NOT the park metric and must not be read as one. Parks are not visible in run records: take them from the
operator's query, grouped by the model of the run.

A follow-up can arrive minutes after the run that caused it, so the newest `--settle-minutes` of runs
are left out of the counts.

Signal that is NOT in the run records, and must come from elsewhere: text-only end_turn rate and tool
calls per run (agent transcripts), merged PRs (GitHub), replay 400s and safety-net retries (CLIProxy log,
`muse_replay_hit_rate.py`).

Usage:
    muse_canary_metrics.py --since 2026-10-03T10:00Z [--until ...] [--by-agent] [--agent ID ...] [--json]
    muse_canary_metrics.py --since ... --dump runs.json     # save the fetched window
    muse_canary_metrics.py --from-file runs.json --since ... # offline
    muse_canary_metrics.py --power --baseline 4.0 --drop 30 # runs per arm needed, no network
    muse_canary_metrics.py --selftest
"""
import argparse
import collections
import datetime
import json
import math
import os
import re
import statistics
import sys
import urllib.request

FOLLOWUP_REASONS = ("issue_continuation_needed", "finish_successful_run_handoff")
FINISHED = ("succeeded", "failed", "cancelled", "timed_out")
EFFORT_SUFFIX = re.compile(r"\([^)]*\)\s*$")
PAGE = 1000


def parse_ts(s):
    """ISO-8601 with Z or offset -> aware UTC datetime. Accepts 2026-10-03T10:00Z and full millis."""
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d(\+00:00)?", s):
        s = s.replace("+00:00", "") + ":00+00:00"
    return datetime.datetime.fromisoformat(s).astimezone(datetime.timezone.utc)


def model_of(run):
    m = (run.get("usageJson") or {}).get("model")
    if not m:
        return None
    return EFFORT_SUFFIX.sub("", str(m)).strip() or None


def arm_of(model, canary, control):
    if model is None:
        return None
    if any(model.startswith(p) for p in canary):
        return "canary"
    if any(model.startswith(p) for p in control):
        return "control"
    return None


def _get(url, key, timeout):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise SystemExit("%s returned HTTP %d" % (url, resp.status))
        return json.load(resp)


def fetch_runs(base, key, company, since, only_agents=None, timeout=180):
    """Company-wide `heartbeat-runs` returns only the newest 1000 rows and ignores offset, status and
    time filters (measured 2026-10-03: ~4 h of fleet history), so the window is read per agent with the
    `agentId` filter, which does work. An agent that returned a full page that still ends after `since`
    is truncated and is reported, because its older runs are missing."""
    base = base.rstrip("/")
    agents = [a["id"] for a in _get("%s/api/companies/%s/agents" % (base, company), key, timeout)]
    if only_agents:
        agents = [a for a in agents if a in set(only_agents)]
    runs, truncated = {}, []
    for aid in agents:
        page = _get("%s/api/companies/%s/heartbeat-runs?limit=%d&agentId=%s" % (base, company, PAGE, aid), key, timeout)
        if not isinstance(page, list):
            raise SystemExit("unexpected heartbeat-runs body: %.200s" % json.dumps(page))
        for r in page:
            runs[r["id"]] = r
        if len(page) >= PAGE and parse_ts(page[-1]["createdAt"]) > since:
            truncated.append(aid)
    return list(runs.values()), truncated


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def runs_needed(baseline, drop, alpha_z=1.96, power_z=0.8416):
    """Succeeded runs needed PER ARM to detect a relative `drop` of a per-run rate `baseline` (both as
    fractions) with a two-sided 5 % test at 80 % power. Assumes independent runs; runs on one card or by
    one agent are correlated, so treat it as a floor."""
    p1, p2 = baseline, baseline * (1 - drop)
    pb = (p1 + p2) / 2
    num = alpha_z * math.sqrt(2 * pb * (1 - pb)) + power_z * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return math.ceil(num * num / ((p1 - p2) ** 2))


def attribute(runs):
    """Return ({cause_run_id: set(reasons)}, unattributed Counter by reason)."""
    by_id = {r["id"]: r for r in runs}
    ordered = collections.defaultdict(list)
    for r in runs:
        if r.get("status") == "succeeded":
            ordered[(r.get("agentId"), (r.get("contextSnapshot") or {}).get("issueId"))].append(r)
    for lst in ordered.values():
        lst.sort(key=lambda r: r["createdAt"])
    caused, lost = collections.defaultdict(set), collections.Counter()
    for f in runs:
        reason = (f.get("contextSnapshot") or {}).get("wakeReason")
        if reason not in FOLLOWUP_REASONS:
            continue
        cause = by_id.get(f.get("retryOfRunId")) if f.get("retryOfRunId") else None
        if cause is None:
            key = (f.get("agentId"), (f.get("contextSnapshot") or {}).get("issueId"))
            earlier = [r for r in ordered.get(key, []) if r["createdAt"] < f["createdAt"] and r["id"] != f["id"]]
            cause = earlier[-1] if earlier else None
        if cause is None:
            lost[reason] += 1
            continue
        caused[cause["id"]].add(reason)
    return caused, lost


def pct(k, n):
    return 100.0 * k / n if n else 0.0


def summarize(runs, canary, control, since, until, settle_minutes, by_agent, truncated=()):
    horizon = until - datetime.timedelta(minutes=settle_minutes)
    inwin = [r for r in runs if since <= parse_ts(r["createdAt"]) <= until]
    caused, lost = attribute(inwin)
    groups = collections.defaultdict(list)
    for r in inwin:
        arm = arm_of(model_of(r), canary, control)
        if arm is None or r.get("status") not in FINISHED:
            continue
        if parse_ts(r["createdAt"]) > horizon:
            continue
        groups[arm].append(r)
        if by_agent:
            groups["%s/%s" % (arm, r.get("agentId"))].append(r)
    out = {}
    for name, rs in sorted(groups.items()):
        succ = [r for r in rs if r["status"] == "succeeded"]
        n = len(succ)
        row = {
            "runs": len(rs),
            "succeeded": n,
            "failed": sum(1 for r in rs if r["status"] == "failed"),
            "agents": len({r.get("agentId") for r in rs}),
            "liveness": dict(collections.Counter(r.get("livenessState") or "none" for r in succ)),
            "failure_codes": dict(collections.Counter(r.get("errorCode") or "none" for r in rs if r["status"] == "failed")),
        }
        for reason in FOLLOWUP_REASONS:
            k = sum(1 for r in succ if reason in caused.get(r["id"], ()))
            lo, hi = wilson(k, n)
            row[reason] = {"count": k, "per_100": round(pct(k, n), 2), "ci95_per_100": [round(100 * lo, 2), round(100 * hi, 2)]}
        k = sum(1 for r in succ if caused.get(r["id"]))
        lo, hi = wilson(k, n)
        row["any_followup"] = {"count": k, "per_100": round(pct(k, n), 2), "ci95_per_100": [round(100 * lo, 2), round(100 * hi, 2)]}
        outs = [(r.get("usageJson") or {}).get("outputTokens") for r in succ]
        ins = [(r.get("usageJson") or {}).get("inputTokens") for r in succ]
        cost = [(r.get("usageJson") or {}).get("costUsd") for r in succ]
        for label, vals in (("output_tokens", outs), ("input_tokens", ins), ("cost_usd", cost)):
            vals = [v for v in vals if isinstance(v, (int, float))]
            row["median_" + label] = round(statistics.median(vals), 4) if vals else None
        out[name] = row
    out["_meta"] = {
        "window": [since.isoformat(), until.isoformat()],
        "settle_minutes": settle_minutes,
        "runs_in_window": len(inwin),
        "unattributed_followups": dict(lost),
        "truncated_agents": list(truncated),
    }
    return out


HEADLINE = "finish_successful_run_handoff"


def verdict(summary, baseline_drop):
    c, k = summary.get("canary"), summary.get("control")
    if not c or not k:
        return "no verdict: need runs in both arms (canary=%s, control=%s)" % (bool(c), bool(k))
    cr, kr = c[HEADLINE], k[HEADLINE]
    if kr["per_100"] == 0:
        return "no verdict: control arm has zero %s follow-ups; widen the window" % HEADLINE
    need = runs_needed(kr["per_100"] / 100.0, baseline_drop)
    small = min(c["succeeded"], k["succeeded"])
    change = 100.0 * (cr["per_100"] - kr["per_100"]) / kr["per_100"]
    lines = [
        "%s: canary %.2f vs control %.2f per 100 succeeded runs (relative change %+.0f%%)" % (HEADLINE, cr["per_100"], kr["per_100"], change),
        "95%% intervals %s" % ("overlap: not distinguishable yet" if cr["ci95_per_100"][1] >= kr["ci95_per_100"][0] else "do not overlap"),
        "sample: smaller arm has %d succeeded runs; ~%d per arm are needed to detect a %d%% drop at the control rate"
        % (small, need, round(100 * baseline_drop)),
    ]
    if small < need:
        lines.append("UNDERPOWERED for that drop: a flat result is inconclusive, not a negative")
    return "\n".join(lines)


def render(summary, verdict_text):
    cols = ("runs", "succeeded", "failed", "agents")
    lines = []
    for name, row in summary.items():
        if name == "_meta":
            continue
        lines.append("%-44s runs=%d succeeded=%d failed=%d agents=%d" % (name, row["runs"], row["succeeded"], row["failed"], row["agents"]))
        for reason in FOLLOWUP_REASONS + ("any_followup",):
            v = row[reason]
            lines.append("    %-32s %4d  %6.2f per 100  (95%% CI %.2f-%.2f)" % (reason, v["count"], v["per_100"], v["ci95_per_100"][0], v["ci95_per_100"][1]))
        lines.append("    liveness %s  failures %s" % (row["liveness"], row["failure_codes"]))
        lines.append("    median per succeeded run: output_tokens=%s input_tokens=%s cost_usd=%s" % (
            row["median_output_tokens"], row["median_input_tokens"], row["median_cost_usd"]))
    m = summary["_meta"]
    lines.append("window %s .. %s, %d runs seen, newest %d min excluded; unattributed follow-ups: %s" % (
        m["window"][0], m["window"][1], m["runs_in_window"], m["settle_minutes"], m["unattributed_followups"] or "none"))
    if m["truncated_agents"]:
        lines.append("WARNING: %d agent(s) returned 1000 runs that all postdate --since, so older runs are missing: %s"
                     % (len(m["truncated_agents"]), ", ".join(m["truncated_agents"])))
    lines.append(verdict_text)
    return "\n".join(lines)


def _run(i, agent, issue, status, model, created, reason=None, retry_of=None, live="completed", out=100):
    return {
        "id": i, "agentId": agent, "status": status, "createdAt": created, "retryOfRunId": retry_of,
        "livenessState": live, "errorCode": None,
        "contextSnapshot": {"issueId": issue, "wakeReason": reason},
        "usageJson": {"model": model, "outputTokens": out, "inputTokens": 1000, "costUsd": 0.1},
    }


def selftest():
    t = lambda m: "2026-10-03T10:%02d:00.000Z" % m
    ctl, can = "muse-spark-1.3-contributor(xhigh)", "muse-canary(xhigh)"
    runs = [
        # control: r1 parks (continuation, linked), r2 parks (handoff, unlinked, latest earlier run), r3 clean
        _run("c1", "A", "I1", "succeeded", ctl, t(1)),
        _run("c1f", "A", "I1", "succeeded", ctl, t(2), "issue_continuation_needed", retry_of="c1"),
        _run("c2", "B", "I2", "succeeded", ctl, t(3)),
        _run("c2b", "B", "I2", "succeeded", ctl, t(4)),
        _run("c2f", "B", "I2", "succeeded", ctl, t(5), "finish_successful_run_handoff"),
        _run("c3", "A", "I3", "succeeded", ctl, t(6)),
        # canary: one clean, one failed, one unattributable handoff
        _run("k1", "C", "I4", "succeeded", can, t(7)),
        _run("k2", "C", "I5", "failed", can, t(8), live="failed"),
        _run("kf", "D", "I9", "succeeded", can, t(9), "finish_successful_run_handoff"),
        # other model, running run, and a run newer than the settle horizon are all ignored
        _run("o1", "E", "I6", "succeeded", "claude-sonnet-5-5", t(10)),
        _run("before", "A", "I0", "succeeded", ctl, "2026-10-03T09:50:00.000Z"),
        _run("after", "A", "I0", "succeeded", ctl, "2026-10-03T11:30:00.000Z"),
        _run("run1", "C", "I7", "running", can, t(11)),
        _run("new", "C", "I8", "succeeded", can, t(58)),
    ]
    since, until = parse_ts("2026-10-03T10:00Z"), parse_ts("2026-10-03T11:00Z")
    s = summarize(runs, ("muse-canary",), ("muse-spark-1.3-contributor",), since, until, 10, by_agent=True)
    k, c = s["control"], s["canary"]
    assert k["succeeded"] == 6 and k["runs"] == 6, k  # c1,c1f,c2,c2b,c2f,c3; not the runs before/after the window
    caused, _ = attribute([r for r in runs if r["id"] not in ("before", "after")])
    assert caused == {"c1": {"issue_continuation_needed"}, "c2b": {"finish_successful_run_handoff"}}, caused
    assert k["issue_continuation_needed"]["count"] == 1, k
    assert k["finish_successful_run_handoff"]["count"] == 1, k  # attributed to c2b, not c2
    assert k["any_followup"]["count"] == 2, k
    assert c["runs"] == 3 and c["succeeded"] == 2 and c["failed"] == 1, c  # k1,k2,kf; 'new' is after the horizon
    assert c["any_followup"]["count"] == 0, c  # kf's handoff has no earlier run to blame
    assert s["_meta"]["unattributed_followups"] == {"finish_successful_run_handoff": 1}, s["_meta"]
    assert s["_meta"]["runs_in_window"] == 12, s["_meta"]
    assert "control/A" in s and "canary/C" in s
    assert "claude-sonnet-5-5" not in json.dumps(s)
    s_t = summarize(runs, ("muse-canary",), ("muse-spark-1.3-contributor",), since, until, 10, False, truncated=["A"])
    assert "WARNING" in render(s_t, "v") and "WARNING" not in render(s, "v")
    # the same follow-up must not be counted twice when both reasons point at one cause
    both = runs + [_run("c1h", "A", "I1", "succeeded", ctl, t(12), "finish_successful_run_handoff", retry_of="c1")]
    s2 = summarize(both, ("muse-canary",), ("muse-spark-1.3-contributor",), since, until, 10, False)["control"]
    assert s2["any_followup"]["count"] == 2, s2  # c1 caused two follow-ups but is one parked run
    assert s2["issue_continuation_needed"]["count"] == 1 and s2["finish_successful_run_handoff"]["count"] == 2, s2
    assert model_of({"usageJson": {"model": "muse-spark-1.3-contributor(xhigh)"}}) == "muse-spark-1.3-contributor"
    assert model_of({"usageJson": None}) is None
    assert arm_of("muse-canary", ("muse-canary",), ("muse-spark",)) == "canary"
    lo, hi = wilson(0, 0)
    assert (lo, hi) == (0.0, 0.0)
    lo, hi = wilson(4, 100)
    assert 0.015 < lo < 0.04 < hi < 0.10, (lo, hi)
    # 4 per 100 baseline, 30% drop: a few thousand runs per arm, and fewer for a bigger drop
    assert 3000 < runs_needed(0.04, 0.30) < 4200
    assert runs_needed(0.04, 0.50) < runs_needed(0.04, 0.30)
    assert "UNDERPOWERED" in verdict(s, 0.30)
    assert "no verdict" in verdict({"control": k}, 0.30)
    assert parse_ts("2026-10-03T10:00Z") == parse_ts("2026-10-03T10:00:00.000Z")
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--since", help="window start, e.g. 2026-10-03T10:00Z")
    ap.add_argument("--until", help="window end (default now)")
    ap.add_argument("--canary-model", action="append", help="model prefix of the canary arm (repeatable)")
    ap.add_argument("--control-model", action="append", help="model prefix of the control arm (repeatable)")
    ap.add_argument("--settle-minutes", type=int, default=30)
    ap.add_argument("--by-agent", action="store_true")
    ap.add_argument("--agent", action="append", help="restrict to this agent id (repeatable)")
    ap.add_argument("--drop", type=float, default=30.0, help="relative drop to power for, percent (default 30)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--from-file")
    ap.add_argument("--dump", help="write the fetched window to this JSON file")
    ap.add_argument("--power", action="store_true", help="print runs needed per arm and exit")
    ap.add_argument("--baseline", type=float, default=4.0, help="control rate per 100 succeeded runs for --power")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        return
    if a.power:
        for d in (20, 30, 40, 50):
            print("baseline %.1f per 100, %d%% drop: %d succeeded runs per arm" % (a.baseline, d, runs_needed(a.baseline / 100, d / 100)))
        return
    if not a.since:
        ap.error("--since is required")
    since = parse_ts(a.since)
    until = parse_ts(a.until) if a.until else datetime.datetime.now(datetime.timezone.utc)
    truncated = []
    if a.from_file:
        runs = json.load(open(a.from_file))
    else:
        for v in ("PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID"):
            if not os.environ.get(v):
                raise SystemExit("%s is not set" % v)
        runs, truncated = fetch_runs(os.environ["PAPERCLIP_API_URL"], os.environ["PAPERCLIP_API_KEY"],
                                     os.environ["PAPERCLIP_COMPANY_ID"], since, a.agent)
        if a.dump:
            json.dump(runs, open(a.dump, "w"))
    summary = summarize(runs, tuple(a.canary_model or ["muse-canary"]), tuple(a.control_model or ["muse-spark-1.3-contributor"]),
                        since, until, a.settle_minutes, a.by_agent, truncated)
    v = verdict(summary, a.drop / 100.0)
    if a.json:
        summary["_verdict"] = v
        print(json.dumps(summary, indent=2))
    else:
        print(render(summary, v))


if __name__ == "__main__":
    main()
