# TOG-11792: run model decision hook (Paperclip fork commits)

The commits target `TogetherWeOwn/paperclip`, base `master` at `9b85ab134`. The
agent token that built them is scoped to `paperclip-model-router`; its push to
the fork returned 403. They are kept here so the work survives the worker.

- `tog-11792.bundle`: `git bundle` of `9b85ab134..2c58d6848`. Exact commits and SHAs.
- `tog-11792.mbox`: the same five commits as `git format-patch` output.
  sha256 `5a9541c0a71c1e7c100ca567a6614a7e3a242f5591c429e97958c75b1eb79097`.

Push from a clone of the fork that has `9b85ab134`:

    git fetch /path/to/tog-11792.bundle 2c58d6848beaf9e989c5b7e28fd9963418b13bb4
    git push origin 2c58d6848beaf9e989c5b7e28fd9963418b13bb4:refs/heads/feat/tog-11792-run-model-decision-hook

Then open the PR against `master` (title and body on the handoff card).
