# One immutable historical scanner finding

The repository preserves a sanitizer regression fixture in commit
`cd0f27a548cc0d93fd5679b36a14341d04123894`. Gitleaks correctly recognizes its
credential-shaped synthetic assignment. The complete authored test passes it to
the publication sanitizer and verifies omission; it does not authenticate or
perform a network/secret-resolution call. The current fixture is inert, but a
full-history scan still finds the old object. History and refs are preserved.

Independent security review authorized exactly one commit-scoped fingerprint in
`.gitleaksignore`. This is metadata, not a credential, path-wide allowance or
permission for a future match. The unchanged scanner rules, working-tree scan,
all-ref history scan, integrity pin and required CI aggregation remain the gates.
Removing the row restores the historical finding and holds those gates again.

## Executable contract

The existing CI step runs `scripts/gitleaks-selftest.sh`, which now also invokes
`scripts/gitleaks-history-selftest.py`. Run it with the same verified Gitleaks
8.21.2 binary as CI:

```sh
bash scripts/gitleaks-selftest.sh /path/to/verified/gitleaks
```

The history helper first requires the pinned scanner, the exact sole policy row
and a working, non-shallow Git checkout without partial-clone/promisor metadata.
Object lookup uses structured `git cat-file` output with lazy fetching disabled:
only exit 0, empty stderr and the exact single missing-object response establish
absence. Git/tool failures, any stderr (including exit-0 corruption diagnostics),
and malformed or non-commit responses fail. It never fetches an unavailable object.
Git and scanner subprocesses clear inherited `GIT_*` overrides before enforcing
`GIT_NO_LAZY_FETCH=1`, so repository/index/object/config environment selectors cannot
redirect disposable fixture operations into the caller's checkout.

When the immutable commit is present, it fails closed unless all of these hold:

- `.gitleaksignore` contains the sole exact authorized non-comment row. Missing,
  malformed, unscoped, whitespace-altered, duplicate and extra entries fail.
- The historical Git blob, complete patch SHA-256 and finding-line SHA-256 match
  the independently reviewed identities pinned in the helper.
- Scanning the introducing commit with an explicit empty ignore yields exit 1
  and exactly the reviewed commit/path/rule/start-line finding. Scanning it with
  the actual policy yields exit 0 and zero findings. It records only redacted
  audit counts: `historical raw=1 adjudicated=1 unsuppressed=0`.
- Every individually changed fingerprint field restores detection. New commits
  containing the same value at the same path/line, an adjacent value, an adjacent
  path or an adjacent line still fail with exactly the expected finding. Original
  and modified working-tree copies also fail.
- A commit-scope-removal mutant is rejected. The helper demonstrates the pinned
  scanner's overbroad suppression for that global key, then proves the legitimate
  new-commit control rejects that verdict. It also tests malformed/missing
  reports, wrong counts/identities, unredacted output and scanner error exits.

### Absent-object mode after a squash merge

Squash merging does not put the original feature commits in `main`. A main-only
checkout may therefore report the exact immutable commit as missing. Its row
cannot suppress a nonexistent object: only the historical blob/patch/line checks,
introducing-commit scans and historical wrong-field scans are inapplicable.

The helper prints `historical object=absent disposition=inert`, states that no
historical finding was scanned or suppressed, and recommends independently
reviewing removal of the inert row. It does not remove the row or any ref itself,
and does not print the present-object `1/1/0` audit counts for this mode.

All exact-policy, wrong-field-policy, report/error and new-match controls still
run. The new-commit, adjacent-value/path/line, working-tree and global-mutant
controls use a deterministic high-entropy synthetic assignment assembled at
runtime when the original line is unavailable. This is a scanner-positive
control, not a substitute historical identity or an additional exception. If the
object becomes available again, all original provenance controls run again.

Fast regressions run with `python3 scripts/test_gitleaks_history_selftest.py -v`
and through `npm test`. They cover structured absence, Git errors/timeouts,
non-repositories, shallow/partial checkouts, malformed/non-commit responses,
immutable identity drift, unchanged refs, policy/version rejection and scanner/report
errors. A real corrupt loose object reproduces Git's exit-0 missing response with
stderr and verifies rejection. A polluted `GIT_DIR` regression snapshots the
caller's HEAD, refs and staged index before fixture initialization and verifies all
remain unchanged afterward. The orchestration tests use a scanner simulator; the
CI scanner job independently runs the real pinned binary.

Gitleaks 8.21.2 automatically loads `source/.gitleaksignore` **in addition to** an
explicit `--gitleaks-ignore-path` ([pinned implementation](https://github.com/gitleaks/gitleaks/blob/v8.21.2/cmd/root.go)).
An empty external file alone therefore cannot establish raw detection in the
current checkout. The helper uses a disposable local no-checkout clone of the
same repository, outside the synced tree, to prevent that implicit exception.
The source refs are never changed. Synthetic inputs are recovered privately from
the immutable object and assembled only in disposable fixtures; no new matching
literal or captured tool output is committed or printed.

After the self-test, still run both normal scans, without changing their scope:

```sh
gitleaks dir . --config .gitleaks.toml --redact --no-banner --verbose
gitleaks git . --config .gitleaks.toml --redact --no-banner
```

A provenance self-test does not replace either scan or independent review. Any
additional historical finding or change in scanner semantics requires a new
security decision; it must not inherit this row. No history rewrite, ref deletion,
rule exemption, blanket baseline, gate override or deployment is authorized.
