#!/usr/bin/env python3
"""Multi-account probe for Muse reasoning replay through CLIProxy (TOG-12934).

The single-account probe that cleared the naive pass-through (tog.2) cannot see the production
failure: Meta binds a reasoning envelope to the account that issued it, and a long agent run's
history mixes envelopes from several pool accounts. This probe plays a Claude Code style tool loop
against CLIProxy `/v1/messages` and forces consecutive turns onto different pool accounts by sending
a fresh session id per turn (no session affinity, so the pool rotates).

It passes only if
  * no turn fails - in particular no 400 "not issued to this caller" reaches the client;
  * with tags expected (the default) every returned thinking signature is a `meta#<account>#...` tag;
  * with rotation (the default) at least two distinct accounts served the loop, otherwise the run proves
    nothing about cross-account history and the probe says so and fails.

It cannot see which envelopes CLIProxy forwarded. Read that from the CLIProxy log lines
"meta reasoning replay: ... kept=N dropped_foreign=N" for the same window (muse_replay_hit_rate.py).

Usage:
    CLIPROXY_API_KEY=... muse_replay_multiaccount_probe.py --base-url http://cliproxy:8317 --turns 8
    muse_replay_multiaccount_probe.py --selftest
Use --no-expect-tags for a model the feature is not enabled for, and --no-rotate to reuse one session id
and watch affinity instead of forcing rotation.
"""
import argparse
import contextlib
import io
import json
import os
import sys
import threading
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

DEFAULT_MODEL = "muse-spark-1.3"
TOOL = {
    "name": "Bash",
    "description": "Run a shell command and return its output.",
    "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
}
SYSTEM = (
    "You are testing a tool loop. On every turn call the Bash tool exactly once with the command "
    "`echo step-N` where N is the number of tool results so far plus one. After {turns} tool results, "
    "answer with the single word DONE and call no tool."
)


def post(base_url, api_key, payload, session_id, timeout):
    req = urllib.request.Request(
        base_url.rstrip("/") + "/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "authorization": "Bearer " + api_key,
            "anthropic-version": "2023-06-01",
            "x-claude-code-session-id": session_id,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(body)
        except ValueError:
            return err.code, {"raw": body[:500]}


def account_key(signature):
    """Return the account key of a meta#<account>#<envelope> tag, or None."""
    if not signature.startswith("meta#"):
        return None
    key, sep, envelope = signature[len("meta#"):].partition("#")
    return key if sep and key and envelope else None


def run(args):
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        print("API key variable is not set; export the one named by --api-key-env", file=sys.stderr)
        return 2
    messages = [{"role": "user", "content": "Start."}]
    accounts, failures = [], []
    stable_session = str(uuid.uuid4())
    for turn in range(1, args.turns + 1):
        payload = {
            "model": args.model,
            "max_tokens": args.max_tokens,
            "system": SYSTEM.format(turns=args.turns),
            "tools": [TOOL],
            "messages": messages,
        }
        session = str(uuid.uuid4()) if args.rotate else stable_session
        status, body = post(args.base_url, api_key, payload, session, args.timeout)
        if status != 200:
            msg = json.dumps(body)[:300]
            failures.append(f"turn {turn}: HTTP {status} {msg}")
            if "not issued to this caller" in msg:
                failures.append(f"turn {turn}: the replay 400 reached the client - the retry safety net did not hold")
            break
        content = body.get("content", [])
        thinking = [b for b in content if b.get("type") == "thinking"]
        tool_use = [b for b in content if b.get("type") == "tool_use"]
        usage = body.get("usage", {}).get("input_tokens")
        key = None
        if thinking:
            key = account_key(thinking[0].get("signature", ""))
            if args.expect_tags and key is None:
                failures.append(f"turn {turn}: thinking signature is not a meta# tag: {thinking[0].get('signature', '')[:40]!r}")
        elif args.expect_tags:
            failures.append(f"turn {turn}: no thinking block returned, nothing to tag")
        accounts.append(key)
        print(f"turn {turn:2d}: account={key or '-':<18} input_tokens={usage} tool_calls={len(tool_use)}")
        if not tool_use:
            break
        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": t["id"], "content": f"step-{turn}"} for t in tool_use
        ]})
    seen = sorted({a for a in accounts if a})
    print(f"\nturns completed: {len(accounts)}  distinct accounts seen: {len(seen)} {seen}")
    if len(accounts) < args.min_turns:
        failures.append(f"only {len(accounts)} turns completed, need {args.min_turns}")
    if args.rotate and args.expect_tags and len(seen) < 2:
        failures.append("the pool never rotated accounts: this run says nothing about cross-account history")
    for f in failures:
        print("FAIL:", f)
    print("PASS" if not failures else "FAILED")
    return 0 if not failures else 1


class _Fake(BaseHTTPRequestHandler):
    mode = "ok"
    turn = 0
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        with _Fake.lock:
            _Fake.turn += 1
            n = _Fake.turn
        if _Fake.mode == "reject" and n >= 3:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"reasoning encrypted_content was not issued to this caller"}}')
            return
        acct = ["aaaa", "bbbb", "cccc"][n % 3] if _Fake.mode != "single" else "aaaa"
        sig = f"meta#{acct}#Q-PaDg-{n}" if _Fake.mode != "untagged" else f"Q-PaDg-{n}"
        resp = {"content": [
            {"type": "thinking", "thinking": "", "signature": sig},
            {"type": "tool_use", "id": f"toolu_{n}", "name": "Bash", "input": {"command": f"echo step-{n}"}},
        ], "usage": {"input_tokens": 100 + 10 * len(body["messages"])}}
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)


def selftest():
    def probe(mode, **kw):
        _Fake.mode, _Fake.turn = mode, 0
        srv = HTTPServer(("127.0.0.1", 0), _Fake)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        os.environ["PROBE_SELFTEST_KEY"] = "k"
        ns = argparse.Namespace(base_url=f"http://127.0.0.1:{srv.server_port}", api_key_env="PROBE_SELFTEST_KEY",
                                model=DEFAULT_MODEL, turns=6, max_tokens=64, timeout=5, rotate=True,
                                expect_tags=True, min_turns=3)
        for k, v in kw.items():
            setattr(ns, k, v)
        try:
            return run(ns)
        finally:
            srv.shutdown()

    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        results = {
            "rotating pool, tagged": probe("ok"),
            "client sees the replay 400": probe("reject"),
            "untagged signatures": probe("untagged"),
            "pool never rotates": probe("single"),
            "affinity run, not rotating": probe("single", rotate=False),
        }
    want = {"rotating pool, tagged": 0, "client sees the replay 400": 1, "untagged signatures": 1,
            "pool never rotates": 1, "affinity run, not rotating": 0}
    assert results == want, (results, sink.getvalue())
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://cliproxy:8317")
    ap.add_argument("--api-key-env", default="CLIPROXY_API_KEY")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--turns", type=int, default=8)
    ap.add_argument("--min-turns", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=1024)
    ap.add_argument("--timeout", type=float, default=180)
    ap.add_argument("--no-rotate", dest="rotate", action="store_false")
    ap.add_argument("--no-expect-tags", dest="expect_tags", action="store_false")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return 0
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
