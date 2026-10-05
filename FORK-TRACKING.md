# Fork tracking

Host fork patches tracked from this repository for builds after the current
cutover packet. Each entry names the patch file under `docs/operator/`, the
host base commit it applies to, and the build it targets. Upstream publication
goes through the audits, steward and operator review path.

| Patch | Base host commit | Target | Status |
| --- | --- | --- | --- |
| `docs/operator/no-progress-no-event-wake-suppression.patch` (doc: `no-progress-no-event-wake-suppression.md`) — suppress run-final-message comments on no-progress, no-event wakes | `14f66a7cf6422b43fe87d1d747ceabdf9f23b583` | Next host build after the current cutover packet | Tracked, awaiting upstream route |
