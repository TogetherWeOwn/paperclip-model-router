# GitHub operation launchers: stop recursive temp-dir nesting

**Result:** a host patch that stops the managed `git`/`gh` launchers from
nesting `paperclip-github-operation-*` temp dirs without end. Live containers
accumulate one ~120-level tree per incident (about 480 KB each), which breaks
`docker system df` with `ENAMETOOLONG` and means the triggering GitHub
operation runs without managed credentials and fails.

This repository does not own the Paperclip host source, so this is the smallest
exact upstream patch plus executable verification. It has not been published to
a third-party repository. Base: host fork commit
`ee341c9b17e6d4c81eb0e54ea79806fb3f90cb31`. Patch sha256
`1ce7f412508372d50a33105c88e8c17585dba61038637a1304644b5e7f55aba3`.
Tracked for the next host build after the current cutover packet; it does not
disturb that packet. Staged launchers are rewritten from this source on every
run, so the fix takes effect on deploy with no migration.

## Problem

Each launcher creates its per-operation dir with
`mkdtemp(path.join(env.GH_CONFIG_DIR || os.tmpdir(), prefix))` and exports the
new dir as the child's `GH_CONFIG_DIR`. Any descendant that resolves back
into a launcher therefore nests one level deeper per hop. Two live shapes were
confirmed:

- A test double that shadows `git`/`gh` on `PATH` while re-executing the
  managed binary as its "real" git (captured via `which git` while the managed
  `PATH` was active). The wrapper spawns the double, the double spawns the
  wrapper, and each hop nests deeper. Process forensics caught the alternating
  `python3 <scratch>/bin/git` / `node <launcher>/git` chain with a deepening
  `GH_CONFIG_DIR` per hop.
- A `PATH` with an empty/relative entry ahead of the real binary plus a
  working-tree file named `git`/`gh` that reaches a launcher, or a shadow
  directory whose `git`/`gh` symlink resolves back into the launcher
  directory. Both were reproduced end to end against the pre-fix source.

The chain runs until `mkdtemp` fails with `ENAMETOOLONG` (about 120 levels),
then every further hop prints `configuration_directory_unavailable` and runs
the real binary with no managed credentials, so authenticated GitHub
operations fail. A relative `GH_CONFIG_DIR` nests by construction for the same
reason. Cleanup only runs on normal process exit, so trees killed harder
persist.

## Fix

In `packages/adapter-utils/src/github-launcher.ts` (staged wrapper source):

- Search only absolute `PATH` entries for the real binary, so empty and
  relative entries can never reselect the launcher through the working
  directory.
- Refuse any candidate whose real path falls inside the launcher's own
  directory, falling through to the next candidate instead of re-executing.
- Anchor a relative `GH_CONFIG_DIR` at `os.tmpdir()` with a
  `configuration_directory_not_absolute` notice on stderr.
- Track nesting in `PAPERCLIP_GITHUB_OPERATION_DEPTH` and exit 127 with an
  `operation_nesting_limit` notice instead of nesting past depth 3, so a
  double/launcher ping-pong fails fast with no residue instead of hanging.
- Await the child and remove the operation dir in a `finally`, replacing the
  exit-hook cleanup with the same coverage on every non-signal death.

## Verification

Host suite `packages/adapter-utils/src/github-launcher.test.ts`: 11 passed
(7 existing plus 4 new regression tests, one per vector above). Each new test
was run against the pre-fix source and fails there (the two re-entry tests by
timeout, the others by assertion). Adjacent suites
`github-launcher-environment.test.ts` and
`server/src/services/heartbeat-github-launchers.test.ts`: 31 passed. Note for
re-runs: execute host tests with a sanitized `PATH` and without ambient
`PAPERCLIP_API_KEY` / `GIT_*` env, otherwise the managed shell leaks launcher
dirs and git vars into the test workers and two unrelated tests misbehave.

## Risks

Low. Normal invocations resolve the same real binary and self-clean exactly as
before; only re-entrant resolutions change (they now skip or refuse). The new
env var is inert to real `git`/`gh`. Legit nesting never exceeds depth 1, so
the depth-3 refusal only fires on true runaways.
