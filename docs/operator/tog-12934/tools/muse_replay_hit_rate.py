#!/usr/bin/env python3
"""Measure the Muse reasoning-replay hit rate from CLIProxy logs (TOG-12934).

Every request that carries Muse reasoning envelopes logs one line:

    meta reasoning replay: model=<m> auth=<id> kept=<n> dropped_foreign=<n> dropped_untagged=<n>

and a request Meta rejected and the proxy retried without envelopes logs:

    meta reasoning replay: Meta rejected <n> replayed reasoning envelope(s) ... retrying once

This reads those lines from files or stdin (e.g. `docker logs cliproxy 2>&1 | ./muse_replay_hit_rate.py`)
and prints how many envelopes were actually replayed.

  item hit rate     kept / (kept + dropped_foreign + dropped_untagged)
  full-hit requests requests where every envelope in the history was replayed
  zero-hit requests requests that carried envelopes but replayed none
  retries           times the 400 safety net fired; should be ~0. Anything above 0 means Meta
                    rejected an envelope the account tag said was safe - look at those requests.

The hit rate is bounded by session affinity: dropped_foreign counts envelopes issued by another pool
account, which is what a lost or expired affinity binding looks like.

Usage:
    muse_replay_hit_rate.py [--json] [--min-requests N] [FILE ...]
    muse_replay_hit_rate.py --selftest
"""
import argparse
import collections
import json
import re
import sys

REPLAY = re.compile(
    r"meta reasoning replay: model=(?P<model>\S+) auth=(?P<auth>\S+) "
    r"kept=(?P<kept>\d+) dropped_foreign=(?P<foreign>\d+) dropped_untagged=(?P<untagged>\d+)"
)
RETRY = re.compile(r"meta reasoning replay: Meta rejected (?P<n>\d+) replayed reasoning envelope")


class Bucket:
    def __init__(self):
        self.requests = 0
        self.kept = 0
        self.foreign = 0
        self.untagged = 0
        self.full_hit = 0
        self.zero_hit = 0

    def add(self, kept, foreign, untagged):
        self.requests += 1
        self.kept += kept
        self.foreign += foreign
        self.untagged += untagged
        if kept and not foreign and not untagged:
            self.full_hit += 1
        if not kept:
            self.zero_hit += 1

    def as_dict(self):
        total = self.kept + self.foreign + self.untagged
        return {
            "requests_with_envelopes": self.requests,
            "envelopes_kept": self.kept,
            "envelopes_dropped_foreign": self.foreign,
            "envelopes_dropped_untagged": self.untagged,
            "item_hit_rate": round(self.kept / total, 4) if total else None,
            "full_hit_requests": self.full_hit,
            "full_hit_request_rate": round(self.full_hit / self.requests, 4) if self.requests else None,
            "zero_hit_requests": self.zero_hit,
        }


def analyse(lines):
    total = Bucket()
    by_model = collections.defaultdict(Bucket)
    by_auth = collections.defaultdict(Bucket)
    retries = 0
    retried_envelopes = 0
    for line in lines:
        m = REPLAY.search(line)
        if m:
            args = (int(m["kept"]), int(m["foreign"]), int(m["untagged"]))
            total.add(*args)
            by_model[m["model"]].add(*args)
            by_auth[m["auth"]].add(*args)
            continue
        r = RETRY.search(line)
        if r:
            retries += 1
            retried_envelopes += int(r["n"])
    return {
        "overall": total.as_dict(),
        "retries_without_replay": retries,
        "retried_envelopes": retried_envelopes,
        "by_model": {k: v.as_dict() for k, v in sorted(by_model.items())},
        "by_auth": {k: v.as_dict() for k, v in sorted(by_auth.items())},
    }


def render(report, min_requests):
    out = []
    o = report["overall"]
    pct = lambda v: "n/a" if v is None else f"{v * 100:.1f}%"
    out.append(f"requests carrying Muse reasoning : {o['requests_with_envelopes']}")
    out.append(f"envelopes kept / foreign / untagged: {o['envelopes_kept']} / {o['envelopes_dropped_foreign']} / {o['envelopes_dropped_untagged']}")
    out.append(f"item hit rate                    : {pct(o['item_hit_rate'])}")
    out.append(f"full-hit requests                : {o['full_hit_requests']} ({pct(o['full_hit_request_rate'])})")
    out.append(f"zero-hit requests                : {o['zero_hit_requests']}")
    out.append(f"400 safety-net retries           : {report['retries_without_replay']}  (want ~0; envelopes involved: {report['retried_envelopes']})")
    for title, key in (("per auth", "by_auth"), ("per model", "by_model")):
        rows = [(k, v) for k, v in report[key].items() if v["requests_with_envelopes"] >= min_requests]
        if len(rows) > 1 or key == "by_model":
            out.append(f"\n{title} (>= {min_requests} requests):")
            for k, v in rows:
                out.append(f"  {k:48s} req={v['requests_with_envelopes']:<6d} hit={pct(v['item_hit_rate']):>6s} full={pct(v['full_hit_request_rate']):>6s}")
    return "\n".join(out)


SAMPLE = """\
time="2026-10-03T01:00:00Z" level=info msg="meta reasoning replay: model=muse-spark-1.3 auth=meta-a.json kept=4 dropped_foreign=0 dropped_untagged=0"
[2026-10-03 01:00:05] [abc] [info ] [meta_reasoning_replay.go:1] meta reasoning replay: model=muse-spark-1.3 auth=meta-b.json kept=1 dropped_foreign=3 dropped_untagged=0
time="2026-10-03T01:00:09Z" level=info msg="meta reasoning replay: model=muse-spark-1.3 auth=meta-b.json kept=0 dropped_foreign=5 dropped_untagged=1"
time="2026-10-03T01:00:10Z" level=warning msg="meta reasoning replay: Meta rejected 2 replayed reasoning envelope(s) as not issued to this caller; retrying once without reasoning"
unrelated line kept=9 dropped_foreign=9
"""


def selftest():
    r = analyse(SAMPLE.splitlines())
    o = r["overall"]
    assert o["requests_with_envelopes"] == 3, o
    assert (o["envelopes_kept"], o["envelopes_dropped_foreign"], o["envelopes_dropped_untagged"]) == (5, 8, 1), o
    assert o["item_hit_rate"] == round(5 / 14, 4), o
    assert o["full_hit_requests"] == 1 and o["zero_hit_requests"] == 1, o
    assert r["retries_without_replay"] == 1 and r["retried_envelopes"] == 2, r
    assert r["by_auth"]["meta-b.json"]["requests_with_envelopes"] == 2
    assert analyse([])["overall"]["item_hit_rate"] is None
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--min-requests", type=int, default=1)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    def lines():
        if not args.files:
            yield from sys.stdin
            return
        for path in args.files:
            with open(path, errors="replace") as fh:
                yield from fh
    report = analyse(lines())
    print(json.dumps(report, indent=2) if args.json else render(report, args.min_requests))


if __name__ == "__main__":
    main()
