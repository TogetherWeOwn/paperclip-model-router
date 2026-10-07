# Fork tracking

Host fork patches tracked from this repository for builds after the current
cutover packet. Each entry names the patch file under `docs/operator/`, the
host base commit it applies to, and the build it targets. Upstream publication
goes through the audits, steward and operator review path.

| Patch | Base host commit | Target | Status |
| --- | --- | --- | --- |
| `docs/operator/no-progress-no-event-wake-suppression.patch` (doc: `no-progress-no-event-wake-suppression.md`) — suppress run-final-message comments on no-progress, no-event wakes | `14f66a7cf6422b43fe87d1d747ceabdf9f23b583` | Next host build after the current cutover packet | Tracked, awaiting upstream route |
| `docs/operator/low-trust-review-model-credential.patch` (doc: `low-trust-review-model-credential.md`) — allow the assigned review agent's model-provider credential binding(s) in low-trust GitHub reviews | `14f66a7cf6422b43fe87d1d747ceabdf9f23b583` | Next host build after the current cutover packet | Tracked, awaiting upstream route |
| `docs/operator/deterministic-review-post-template.patch` (doc: `deterministic-review-post-template.md`) — deterministic Paperclip Review post template (server-rendered summary, inline findings, check run) | `302776c7878881970c0f37941ba8cd3bc1255138` | tog.4 build if ready in time, otherwise next fork release | Tracked, awaiting upstream route |
| `docs/operator/monitor-wake-policy.patch` (doc: `monitor-wake-policy.md`) — minimum monitor interval and quiet-card skip for due monitor wakes | `ee341c9b1` | Next host build after the current cutover packet | Tracked, awaiting upstream route |
| `docs/operator/github-launcher-nesting.patch` (doc: `github-launcher-nesting.md`) — stop managed git/gh launchers nesting operation temp dirs without end (refuse past depth 3, skip self/shadow/relative resolutions, finally-cleanup) | `ee341c9b17e6d4c81eb0e54ea79806fb3f90cb31` | Next host build after the current cutover packet | Tracked, awaiting upstream route |
