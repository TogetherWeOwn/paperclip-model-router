# Emit integration for TOG-13279 (companion to TOG-13279-router-mix-detector.py).
# BEFORE behavior (host finding `operator-detector-source-handoff-20261003-1115`
# and preflight `operator-detector-preflight-stop-20261003-1200` on TOG-12270 /
# TOG-13279): host emit() delivers the message text only when ok is false, so
# every success drops the pace=behind INFO the detector appends. The full host
# file was never exported (only the LANE_OF..router_mix() excerpt region), so
# this block does NOT rewrite emit()'s transport: it is a delegating wrapper.
# The original push behavior is preserved byte-for-behavior (same positional
# args forwarded, return value preserved); the wrapper only ADDS stdout logging
# of the message on both paths, which is what the 5-minute cron log captures.
#
# ASSEMBLY SHAPE (correction v2, see `operator-detector-assembly-stop-20261003-1245`):
# the instructed host file contains TWO module-level emit definitions by
# design: the untouched BEFORE `def emit(key, ok, err)` first, then this
# wrapper `def emit(name, ok, msg)` with `_before_emit` bound between them.
# Name rebinding is the mechanism, not a defect: after this block runs, the
# module name `emit` IS the wrapper, and the wrapper delegates the push to
# `_before_emit` (the BEFORE implementation). A prior VERIFY wrongly required
# one definition; the VERIFY below asserts the intended two-def binding
# instead. All emit call sites (BEFORE router_mix + new detector: 7 total) are
# positional, so the (key,ok,err)/(name,ok,msg) parameter-name difference is
# inert -- proven by `EmitAssemblyTest` in TOG-13279-router-mix-test.py, which
# assembles a host-shaped fixture and runs these same assertions offline.
#
# Deploy (host operator under TOG-12270, with BEFORE copy + rollback):
#   1. Locate the BEFORE `def emit(` line: there must be EXACTLY ONE line
#      starting with `def emit(` in /opt/tog6886-remediate/detect/oncall-detect.py,
#      with args [key, ok, err] (host-observed shape; BEFORE lines 26-27).
#      If there is not exactly one, or the args differ, STOP and return both
#      TOG-13279 blocks.
#   2. Insert this whole file's TOG-13279 block below (BEGIN through END,
#      markers included) immediately AFTER the end of the BEFORE emit() body
#      (the last indented line of that def, before the next top-level
#      statement). Do not edit the BEFORE emit() body itself.
#   3. Reload, then verify: run the command under VERIFY below and record the
#      resulting full host-file SHA256 on TOG-12270. All six lines must print PASS.
# Rollback: delete this inserted block (BEGIN through END inclusive) and
# reload; the BEFORE emit() is untouched in place.
#
# VERIFY (host, after reload; all six must print PASS, then record the checksum):
#   python3 - <<'EOF'
#   import ast
#   src = open('/opt/tog6886-remediate/detect/oncall-detect.py').read()
#   tree = ast.parse(src)
#   defs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'emit']
#   args = [[a.arg for a in d.args.args] for d in defs]
#   print('PASS: two module-level emit defs (BEFORE + wrapper)' if len(defs) == 2 else 'FAIL: emit def count=%d' % len(defs))
#   print('PASS: BEFORE args [key,ok,err], wrapper args [name,ok,msg]' if args == [['key', 'ok', 'err'], ['name', 'ok', 'msg']] else 'FAIL: emit args=%s' % (args,))
#   bind = src.index('_before_emit = emit')
#   print('PASS: _before_emit binds BEFORE impl before wrapper def' if src.index('TOG-13279 emit integration (BEGIN)') < bind < src.index('def emit(name, ok, msg):') else 'FAIL: binding order')
#   print('PASS: wrapper delegates push positionally' if '_before_emit(name, ok, msg)' in src else 'FAIL: delegation')
#   print('PASS: wrapper logs on both paths' if 'print(' in src[src.index('def emit(name, ok, msg):'):] else 'FAIL: logging')
#   calls = [n for n in ast.walk(tree) for n in [n] if isinstance(n, ast.Call) and getattr(n.func, 'id', '') == 'emit']
#   print('PASS: all emit calls positional (%d sites)' % len(calls) if calls and all(not c.keywords for c in calls) else 'FAIL: keyword emit call')
#   EOF
#   sha256sum /opt/tog6886-remediate/detect/oncall-detect.py
# No secrets in this file.

# ===== TOG-13279 emit integration (BEGIN) =====
# Transport-preserving success-INFO fix: BEFORE emit() delivered `msg` only on
# the not-ok path. This wrapper keeps the BEFORE emit as the single push path
# (shared-consumer compatible: identical positional (name, ok, msg) call, same
# return) and additionally logs `msg` to stdout on BOTH paths so the cron log
# retains pace=behind INFO on success. Placement: directly after the BEFORE
# `def emit(...)` body; `_before_emit` binds the BEFORE implementation. If
# `emit` is undefined here, NameError fails the cron run loudly (fail closed,
# no silent swallow).
_before_emit = emit  # noqa: F821 -- bound from the BEFORE host module scope


def emit(name, ok, msg):
    """TOG-13279 wrapper: always log the message text, then delegate the push."""
    print("%s ok=%s %s" % (name, ok, msg), flush=True)
    return _before_emit(name, ok, msg)
# ===== TOG-13279 emit integration (END) =====
