# Routing fidelity — last 24 h

Generated 2026-10-01T21:29:34.184Z. Interim pin-vs-run proxy: each run is compared with the pin as it is now, not the pin at run time. Re-point at contextSnapshot.modelDecision once TOG-11792 ships.

| Metric | Value | Target |
|---|---|---|
| Runs in window | 5000 (2026-10-01T20:53:50.404Z → 2026-10-01T21:28:32.512Z, 134 issues) | — |
| Routed share | 2125/5000 (42.5%) | ≥ 99% |
| No-model runs | 1090 | counted separately |
| Fidelity (normalized) | 1725/1800 (95.8%) | ≥ 99% |
| Fidelity (raw exact match) | 1725/1800 (95.8%) | — |
| … no-model among routed | 325 | — |
| First-run coverage (issue_assigned) | 0/682 (0.0%) | ≥ 99% |
| Escaped runs (configuration_incomplete) | 50 | 0/day |
| Pins with secret_ref env | 64/64 | 0 |

Escaped issues: fbceeef6-1921-4131-9df9-67da0a911f0a, 3541acf7-64ed-45b7-8b67-1e75d26fbb9d
