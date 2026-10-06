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
