# TOG-13238 handoff: fix/1001-h1h9-port push bundle

Parent port: [TOG-13236](/TOG/issues/TOG-13236) (`#document-h1h9-live-mapping`).
This card: [TOG-13238](/TOG/issues/TOG-13238).

## Ready ref (verified 2026-10-03 ~10:05Z)

- Repo: `https://github.com/TogetherWeOwn/paperclip.git`
- Branch: `fix/1001-h1h9-port`
- Base (live): `14f66a7cf6422b43fe87d1d747ceabdf9f23b583`
- Head: `e186c63fbe2aa7ff3731f19efed5ad6be025cd25`
  `fix(plugins): port H1-H9 host wiring onto 1001 line`
- Local source (durable, untouched except reads):
  `/paperclip/instances/default/projects/ef993a7e-5ea7-445f-ba88-27a6a2690c3a/ce15986d-5733-4c83-aa9d-c76a58fae044/port-13236-20261003T095719Z`
  on branch `fix/1001-h1h9-port`, clean.

## Why this bundle exists

Push from this run's token fails (retried 2026-10-03, exact error):

```text
remote: Permission to TogetherWeOwn/paperclip.git denied to togetherweown[bot].
fatal: unable to access 'https://github.com/TogetherWeOwn/paperclip.git/': The requested URL returned error: 403
```

This run is scoped to the Model Router Plugin project
(`paperclip-model-router`); its token cannot write `TogetherWeOwn/paperclip`.
No credential substitution attempted (owner rule 2026-09-29).

## Files

- `fix-1001-h1h9-port.bundle` — `git bundle`, verified `is okay` against the
  paperclip checkout; advertises `e186c63f refs/heads/fix/1001-h1h9-port`,
  requires base `14f66a7cf`.
- `fix-1001-h1h9-port.mbox` — `git format-patch -1 e186c63f` (same change).

## Push recipe (from a Fork-scoped run)

```sh
git clone https://github.com/TogetherWeOwn/paperclip.git paperclip-push
cd paperclip-push
git fetch /path/to/fix-1001-h1h9-port.bundle fix/1001-h1h9-port:fix/1001-h1h9-port
git log --oneline -2 fix/1001-h1h9-port   # expect e186c63f on 14f66a7cf
git push origin fix/1001-h1h9-port
```

Then review/PR/tag/packet resumes on [TOG-13236](/TOG/issues/TOG-13236).
No host build/deploy from this card.
