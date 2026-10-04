# Pacer policy replay report

Fixture: tests/pacer-policy-replay.fixture.json (version 1, 13 synthetic states).
Replay: node scripts/pacer-policy-replay.mjs. Offline; no live capacity poll, no pacing write.
Result: 13/13 states decide as the policy table says.

| State | Expected | Replayed | Match | Why |
| --- | --- | --- | --- | --- |
| s01-healthy-behind-admits | admit | admit | yes | usable lane admits (available, conserve and avoid postures are covered) |
| s02-healthy-ahead-admits | admit | admit | yes | usable lane admits (available, conserve and avoid postures are covered) |
| s03-exhausted-health-denies | deny | deny | yes | explicit exhausted health denies under any policy |
| s04-unavailable-health-denies | deny | deny | yes | explicit unavailable health denies under any policy |
| s05-unknown-telemetry-failopen-admits | admit | admit | yes | unknown telemetry admits under fail-open |
| s06-missing-evidence-failopen-admits | admit | admit | yes | missing evidence admits under fail-open |
| s07-missing-evidence-failclosed-denies | deny | deny | yes | missing evidence denies under fail-closed |
| s08-serviceability-trip-denies | deny | deny | yes | tripped serviceability window denies despite healthy capacity |
| s09-stale-pace-admits | admit | admit | yes | usable lane admits (available, conserve and avoid postures are covered) |
| s10-avoid-posture-admits | admit | admit | yes | usable lane admits (available, conserve and avoid postures are covered) |
| s11-exhausted-pace-without-trip-admits | admit | admit | yes | usable lane admits (available, conserve and avoid postures are covered) |
| s12-missing-evidence-excludelane-denies | deny | deny | yes | missing evidence denies under exclude-lane |
| s13-shadow-never-denies | admit | admit | yes | shadow mode serves the static pool; capacity never denies |
