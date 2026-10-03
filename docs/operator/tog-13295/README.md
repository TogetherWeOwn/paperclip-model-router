# TOG-13295 handoff: lockfile fix for fix/1001-h1h9-port (PR #33)

Parent assist card: [TOG-13295](/TOG/issues/TOG-13295) (Model Router Plugin).
Port epic: [TOG-13236](/TOG/issues/TOG-13236). Review verdict: [TOG-13241](/TOG/issues/TOG-13241).

## Ready ref (verified 2026-10-03 ~12:34Z)

- Repo: `https://github.com/TogetherWeOwn/paperclip.git`
- Branch: `fix/1001-h1h9-port` (PR #33, open, `mergeable_state: unstable`)
- Origin head: `f6e56da0565e0dfcf599e2d27c1acc3eeb2db74d`
  (Merge origin/master into fix/1001-h1h9-port)
- Fix: lockfile-only child `chore(server): sync pnpm lockfile for MCP SDK devDependency`
- Expected result tree: `85a4ea2664597772d5b890bb0b6b4b9250a17477`

## Why this fix exists

`server/package.json` devDependencies carries `@modelcontextprotocol/sdk@^1.30.0`
with no importer entry in `pnpm-lock.yaml`, so every `pnpm install
--frozen-lockfile` fails (reproduced locally 2026-10-03, pnpm 9.15.4):

```text
ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with <ROOT>/server/package.json
```

This reds the `Real Sentry SDK isolation` check on PR #33. Regenerating with the
repo-pinned pnpm 9.15.4 adds exactly one importer entry
(`1.30.0(zod@4.4.3)`, already in the packages index) plus one pnpm
normalization line (`cpu:` drop on `opencode-ai`). After the fix,
`pnpm install --frozen-lockfile --ignore-scripts` exits 0.

## Why a Fork-scope child pushes it

Push from a Model Router Plugin run fails deterministically (precedent
TOG-13238):

```text
remote: Permission to TogetherWeOwn/paperclip.git denied to togetherweown[bot].
fatal: unable to access 'https://github.com/TogetherWeOwn/paperclip.git/': The requested URL returned error: 403
```

No credential substitution attempted (owner rule 2026-09-29).

## Files

- `fix-1001-h1h9-port.lockfile.mbox` — `git format-patch -1` of the fix
  (same patch is also pasted inline in the Fork child description).

No `.bundle`: both available checkouts are shallow, and a shallow repo cannot
express a `base..head` range bundle (fails `lacks prerequisite commits`). The
mbox is sufficient — the pusher verifies by tree hash (below), which is
bundle-equivalent.

## Push recipe (from a Fork-scoped run, GH_APP_REPOS=paperclip)

```sh
git clone https://github.com/TogetherWeOwn/paperclip.git paperclip-push
cd paperclip-push
git checkout f6e56da0565e0dfcf599e2d27c1acc3eeb2db74d
git am /path/to/fix-1001-h1h9-port.lockfile.mbox   # or apply inline patch from child card
git rev-parse HEAD^{tree}   # expect 85a4ea2664597772d5b890bb0b6b4b9250a17477
pnpm install --frozen-lockfile --ignore-scripts     # expect exit 0 (needs pnpm 9.15.4)
git push origin HEAD:refs/heads/fix/1001-h1h9-port  # NO --force; expect fast-forward from f6e56da0
git ls-remote origin fix/1001-h1h9-port
```

If origin moved past `f6e56da0`, STOP and report — do not force, do not rebase.

Then CI re-runs on the new head; review context resumes on [TOG-13241](/TOG/issues/TOG-13241).
No host build/deploy from this card.
