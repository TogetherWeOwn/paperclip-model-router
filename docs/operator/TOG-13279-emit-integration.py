# Emit integration for TOG-13279 (companion to TOG-13279-router-mix-detector.py).
# BEFORE behavior (host finding `operator-detector-source-handoff-20261003-1115`
# and preflight `operator-detector-preflight-stop-20261003-1200` on TOG-12270 /
# TOG-13279): host emit() delivers the message text only when ok is false, so
# every success drops the pace=behind INFO the detector appends. The full host
# file was never exported (only the LANE_OF..router_mix() excerpt region), so
# this block does NOT rewrite emit()'s transport: it is a delegating wrapper
# with the identical signature. The original push behavior is preserved
# byte-for-behavior (same args forwarded, return value preserved); the wrapper
# only ADDS stdout logging of the message on both paths, which is what the
# 5-minute cron log captures.
#
# Deploy (host operator under TOG-12270, with BEFORE copy + rollback):
#   1. Locate the BEFORE `def emit(` line: there must be EXACTLY ONE line
#      starting with `def emit(` in /opt/tog6886-remediate/detect/oncall-detect.py.
#      If there is not exactly one, STOP and return both TOG-13279 blocks.
#   2. Insert this whole file's TOG-13279 block below (BEGIN through END,
#      markers included) immediately AFTER the end of the BEFORE emit() body
#      (the last indented line of that def, before the next top-level
#      statement). Do not edit the BEFORE emit() body itself.
#   3. Reload, then verify: run the command under VERIFY below and record the
#      resulting full host-file SHA256 on TOG-12270.
# Rollback: delete this inserted block (BEGIN through END inclusive) and
# reload; the BEFORE emit() is untouched in place.
#
# VERIFY (host, after reload; all three must print PASS):
#   python3 - <<'EOF'
#   import ast
#   src = open('/opt/tog6886-remediate/detect/oncall-detect.py').read()
#   tree = ast.parse(src)
#   defs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'emit']
#   print('PASS: single module-level emit' if len(defs) == 1 and list(defs[0].args.args and [a.arg for a in defs[0].args.args]) == ['name', 'ok', 'msg'] else 'FAIL: emit signature')
#   print('PASS: wrapper present' if '_before_emit = emit' in src and 'TOG-13279 emit integration (BEGIN)' in src else 'FAIL: wrapper missing')
#   EOF
#   sha256sum /opt/tog6886-remediate/detect/oncall-detect.py
# No secrets in this file.

# ===== TOG-13279 emit integration (BEGIN) =====
# Transport-preserving success-INFO fix: BEFORE emit() delivered `msg` only on
# the not-ok path. This wrapper keeps the BEFORE emit as the single push path
# (shared-consumer compatible: identical (name, ok, msg) call, same return)
# and additionally logs `msg` to stdout on BOTH paths so the cron log retains
# pace=behind INFO on success. Placement: directly after the BEFORE `def
# emit(...)` body; `_before_emit` binds the BEFORE implementation. If `emit`
# is undefined here, NameError fails the cron run loudly (fail closed, no
# silent swallow).
_before_emit = emit  # noqa: F821 -- bound from the BEFORE host module scope


def emit(name, ok, msg):
    """TOG-13279 wrapper: always log the message text, then delegate the push."""
    print("%s ok=%s %s" % (name, ok, msg), flush=True)
    return _before_emit(name, ok, msg)
# ===== TOG-13279 emit integration (END) =====
