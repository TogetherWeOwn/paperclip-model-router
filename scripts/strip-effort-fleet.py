#!/usr/bin/env python3
"""Suppress the ACP-unsupported `effort` key in every agent's cheap model profile.

Background: `runtimeConfig.modelProfiles.cheap.adapterConfig.effort` is a valid
field on the claude_local CLI lane and ships in that adapter's own default cheap
profile, but the ACP engine lane does not advertise it. An agent that downshifts
to the cheap profile on the ACP lane dies with ACP_BACKEND_UNSUPPORTED_CONTROL
and cannot self-heal, because self-repair requires it to be running.

DELETING the key is NOT enough. `resolveModelProfileApplication`
(/app/server/src/services/heartbeat.ts:3520-3526) spreads the ADAPTER DEFAULT
FIRST and the stored profile second:

    adapterConfig: {
      ...parseObject(adapterProfile.adapterConfig),   // <- effort: "low"
      ...runtimeProfile.adapterConfig,                // <- our stored profile
    }

so any key we merely omit is re-supplied by the adapter default at run time. We
must therefore store an explicit falsy `effort: ""`, which both lanes guard on
by truthiness -- ACP at acpx-engine/execute.ts:2137 (`if
(prepared.requestedThinkingEffort)`) and the CLI at claude-local
server/execute.ts:851 (`if (effectiveEffort) args.push("--effort", ...)`).
Regression-tested in /app/server/src/__tests__/tog685-effort-merge.test.ts.

This is a read-modify-write sweep: it preserves every other key in runtimeConfig
(notably `heartbeat`, whose shape is NOT uniform across the fleet -- paused
agents carry a partial block). A wholesale PATCH of runtimeConfig silently drops
those keys.

Usage:
    python3 strip-effort-fleet.py            # dry run, prints the plan
    python3 strip-effort-fleet.py --apply    # perform the PATCHes

Environment: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID,
PAPERCLIP_RUN_ID.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ["PAPERCLIP_API_URL"].rstrip("/").removesuffix("/api")
KEY = os.environ["PAPERCLIP_API_KEY"]
COMPANY = os.environ["PAPERCLIP_COMPANY_ID"]
RUN_ID = os.environ.get("PAPERCLIP_RUN_ID", "")

APPLY = "--apply" in sys.argv


def call(method, path, payload=None):
    req = urllib.request.Request(
        f"{BASE}{path}",
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Content-Type", "application/json")
    if RUN_ID:
        req.add_header("X-Paperclip-Run-Id", RUN_ID)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or "null")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()[:400]


def cheap_profile(runtime_config):
    """Return the stored cheap profile dict (possibly empty)."""
    profiles = (runtime_config or {}).get("modelProfiles") or {}
    return profiles.get("cheap") or {}


def needs_fix(runtime_config):
    """True when this agent could still emit a truthy `effort` on the cheap lane.

    An explicitly disabled profile never enters the merge path, so it is safe.
    Anything else is unsafe unless it already pins a falsy `effort`, because an
    absent key is refilled from the adapter default.
    """
    profile = cheap_profile(runtime_config)
    if profile.get("enabled") is False:
        return False
    return bool((profile.get("adapterConfig") or {}).get("effort", "low"))


def suppress(runtime_config):
    """Copy runtime_config with cheap.adapterConfig.effort pinned to "".

    Every sibling key is carried through untouched -- this is the whole point of
    the function, since PATCH replaces runtimeConfig wholesale.
    """
    out = json.loads(json.dumps(runtime_config or {}))
    profiles = out.setdefault("modelProfiles", {})
    profile = profiles.setdefault("cheap", {})
    profile.setdefault("enabled", True)
    profile.setdefault("adapterConfig", {})["effort"] = ""
    return out


status, body = call("GET", f"/api/companies/{COMPANY}/agents")
if status != 200:
    sys.exit(f"agent list failed: HTTP {status} {body}")
agents = body if isinstance(body, list) else body.get("agents") or body.get("data")

targets = [a for a in agents if needs_fix(a.get("runtimeConfig"))]
print(f"{len(agents)} agents, {len(targets)} can still emit effort on the cheap lane")

failures = []
for agent in targets:
    desired = suppress(agent.get("runtimeConfig"))
    label = f"{agent['id']} {agent.get('name')} ({agent.get('status')})"
    if not APPLY:
        print(f"  would patch {label}")
        continue

    code, resp = call("PATCH", f"/api/agents/{agent['id']}", {"runtimeConfig": desired})
    # Trust the read-back, not the write's status code.
    verify_code, verify = call("GET", f"/api/agents/{agent['id']}")
    ok = verify_code == 200 and not needs_fix(verify.get("runtimeConfig"))
    kept_siblings = verify_code == 200 and set(verify.get("runtimeConfig") or {}) == set(desired)
    print(f"  {'OK ' if ok and kept_siblings else 'FAIL'} HTTP {code} {label}"
          f"{'' if kept_siblings else '  <-- SIBLING KEYS LOST'}")
    if not (ok and kept_siblings):
        failures.append((label, code, resp))

if APPLY:
    print(f"\n{len(targets) - len(failures)}/{len(targets)} verified clean")
    for label, code, resp in failures:
        print(f"  FAILED {label}: HTTP {code} {resp}")
    sys.exit(1 if failures else 0)
