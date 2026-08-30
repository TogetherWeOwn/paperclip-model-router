#!/usr/bin/env bash
# TOG-692 — reproducible memory-facts probe.
#
# Answers, with evidence rather than inference:
#   1. Is the memory-heavy agent process node/V8, or something else?
#   2. Does NODE_OPTIONS reach it at all?
#   3. Which process does the 4288 MiB "V8 ceiling" actually belong to?
#   4. What do agent processes really consume?
#
# Safe to run at any time: read-only apart from spawning `claude --version`.
set -uo pipefail

SDK_GLOB='/app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
BIN=$(ls -d /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude 2>/dev/null | head -1)

echo "=== 0. host ==="
grep -E '^(MemTotal|MemAvailable|SwapTotal)' /proc/meminfo
echo "overcommit_memory=$(cat /proc/sys/vm/overcommit_memory)  (1 = never refuse; allocation failure is NOT the fail mode)"
echo "cgroup memory.max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)  (max = no cgroup cap, so oom_kill counts are host-wide)"

echo
echo "=== 1. is the agent binary node/V8? ==="
[ -n "$BIN" ] || { echo "claude binary not found"; exit 1; }
python3 - "$BIN" <<'PY'
import sys
p=sys.argv[1]
pats=[b'JSC::',b'JavaScriptCore',b'bun.sh',b'Reached heap limit',b'--max-old-space-size']
c={x:0 for x in pats}; prev=b''
with open(p,'rb') as f:
    while (ch:=f.read(8<<20)):
        buf=prev+ch
        for x in pats: c[x]+=buf.count(x)
        prev=ch[-64:]
for x in pats: print(f"  {x.decode():22} {c[x]}")
print("  VERDICT: Bun/JavaScriptCore" if c[b'JSC::'] else "  VERDICT: V8")
print("  NOTE: 'Reached heap limit' (the V8 OOM string) count above should be 0.")
PY

echo
echo "=== 2. does NODE_OPTIONS reach the binary? (flag that hard-fails node) ==="
echo -n "  claude: "; NODE_OPTIONS="--totally-bogus-flag-xyz" timeout 60 "$BIN" --version 2>&1 | head -1
echo -n "  node  : "; NODE_OPTIONS="--totally-bogus-flag-xyz" node -e 'console.log("accepted")' 2>&1 | head -1
echo "  (claude prints a version => ignored; node refuses => NODE_OPTIONS is real for node only)"

echo
echo "=== 2b. the SDK deletes NODE_OPTIONS before spawn ==="
for f in $SDK_GLOB; do
  n=$(grep -c 'delete c.NODE_OPTIONS' "$f" 2>/dev/null)
  echo "  $(basename $(dirname $f)) -> 'delete c.NODE_OPTIONS' occurrences: ${n:-0}"
done

echo
echo "=== 3. whose ceiling is 4288 MiB? ==="
node -e 'console.log("  node ACP wrapper default heap_size_limit:", Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576), "MiB")'

echo
echo "=== 4. what agent processes actually use ==="
python3 - <<'PY'
import glob
rows=[]
for p in glob.glob('/proc/[0-9]*'):
    try:
        cmd=open(p+'/cmdline','rb').read().replace(b'\0',b' ').decode('utf8','replace')
        if not cmd: continue
        st={}
        for line in open(p+'/status'):
            k,_,v=line.partition(':'); st[k]=v.strip()
        rss=int(st.get('VmRSS','0 kB').split()[0]); hwm=int(st.get('VmHWM','0 kB').split()[0])
        if 'claude-agent-sdk-linux-x64/claude' in cmd: rows.append(('claude-binary',rss,hwm))
        elif 'claude-agent-acp' in cmd: rows.append(('acp-wrapper(node)',rss,hwm))
    except Exception: pass
for kind in ('claude-binary','acp-wrapper(node)'):
    xs=[r for r in rows if r[0]==kind]
    if not xs: print(f"  {kind:20} none live"); continue
    print(f"  {kind:20} n={len(xs):<3} totalRSS={sum(x[1] for x in xs)/1024:7.0f} MiB  "
          f"maxRSS={max(x[1] for x in xs)/1024:6.0f} MiB  maxPeak(VmHWM)={max(x[2] for x in xs)/1024:6.0f} MiB")
print("  => compare maxPeak against the 4288 MiB figure the issue is built on.")
PY
