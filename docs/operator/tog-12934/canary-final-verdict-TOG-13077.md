# CTO final verdict: TOG-13077 Muse reasoning-replay canary (48h)

Window: 2026-10-03 16:43:42Z → 2026-10-05 03:54Z, Muse-only, 2x2 (replay x stop-hook).
Sources: agent-side 48h readout (`canary-readout-48h-TOG-13077.md`, commit `a55d8b2a1`);
operator 48h readout comment `69f4294d` (CLIProxy `main.log`, DB run-attributed comments, Keeper).

## Criterion 1 — zero replay 400s: PASS
- Agent-side: 0 replay-400 signatures in 605 post-cut failed runs.
- Operator: 0 agent-visible replay-400s; 43 failover retries / 51,459 reqs = 0.08% (stop rule >1%/2h).
- `dropped_foreign` 8.0% of blocks is the account-mismatch safety net working, not a fault;
  `dropped_untagged` 0; exemplar 429 → new account → 200 shows failover succeeding.

## Criterion 2 — ≥30% (notices+parks)/run drop, control flat: PASS for replay
- Pooled replay OFF 0.0660 → ON 0.0204 = 69% drop (71% within hookOFF, 54% within hookON).
- Hook: 47% alone on OFF stratum, 17% on ON stratum (floor effect — replay already harvested it).
- Day split holds both days; control-flatness OK Muse-only.
- Caveats accepted: role-confounded cells; parks system-authored (test rides on notices).

## Stop rules: none tripped
- No 400s; retries ≪1%; Keeper median fresh-input/event +12.6% (inside +25% cost stop);
  parks not worse (1 total, ON/OFF cell).
- Watch-item (not a trip): mean gateway tool_inv/run lower on replay-ON cells
  (1.97–2.01 vs 2.29–3.46) — confounded by role mix (review volume dominates OFF/OFF)
  and LLM turns hold (ON/ON 22.3 vs OFF/OFF 19.9); re-check on fleet mix during watch period.

## CTO verdict: EXPAND
Flip replay ON for `muse-spark*` (keep the `muse-canary` alias + instant rollback
`touch /paperclip/muse-stop-guard/DISABLED`, full `uninstall --apply`), keep the stop-hook
fleet-wide, and watch replay-400s / retries / parks for one more 48h.
Announce-share stays undefined (needs transcript sampling, not a gate).

Expansion GO is the CEO's (this card reserves it); execution is host/operator work via
parent TOG-12934. No upstream PR from this card.
