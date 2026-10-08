#!/usr/bin/env python3
"""Prove the sole historical exception cannot suppress any new finding.

Called by the CI-executed scanner self-test. No repository refs are changed.
Synthetic inputs are recovered privately when the immutable object is present,
otherwise assembled at runtime; scanner output is captured, never echoed.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


COMMIT = "cd0f27a548cc0d93fd5679b36a14341d04123894"
FILE = "docs/operator/deterministic-review-post-template.patch"
RULE = "generic-api-key"
LINE = 1520
BLOB = "4a6d8c3853181ad61a4eccbec2fb7ffb99b66987"
PATCH_SHA256 = "3721078966130ca927457dc60524d0b58173e46e9a9444ffe2cf3b03ec90e0b7"
LINE_SHA256 = "23e3fb83d493b3eb73160286cd950fbb7c486df58c7c40ff352ce334fddf0a8b"
FINGERPRINT = f"{COMMIT}:{FILE}:{RULE}:{LINE}"
ROOT = Path(__file__).resolve().parent.parent


class SelfTestError(Exception):
    """An error safe to print: never includes captured tool output or input."""


def require(condition, message):
    if not condition:
        raise SelfTestError(message)


def validate_ignore(path):
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise SelfTestError("historical ignore file missing or unreadable") from None
    entries = [line for line in lines if line.strip() and not line.lstrip().startswith("#")]
    require(entries == [FINGERPRINT], "historical ignore must contain exactly the authorized commit-scoped row")


def validate_report(returncode, path, expected):
    require(returncode in (0, 1), "scanner execution failed")
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        raise SelfTestError("scanner report missing or malformed") from None
    require(isinstance(report, list), "scanner report must be a list")
    require(returncode == (1 if expected else 0), "scanner exit code disagrees with expected verdict")
    require(len(report) == len(expected), "scanner finding count disagrees with expected verdict")
    identities = []
    for finding in report:
        require(isinstance(finding, dict), "scanner finding malformed")
        require(finding.get("Secret") == "REDACTED", "scanner report is not fully redacted")
        identities.append(tuple(finding.get(key) for key in ("Commit", "File", "RuleID", "StartLine")))
    require(identities == expected, "scanner finding identity disagrees with expected verdict")
    return len(report)


def expect_rejected(label, operation):
    try:
        operation()
    except SelfTestError:
        print(f"PASS  {label}: rejected")
        return
    raise SelfTestError(f"{label}: invalid control was accepted")


def git_environment():
    # Inherited repository/index/object/config overrides can redirect fixture
    # writes despite cwd. Resolve Git from each requested checkout, never a caller.
    return {**{key: value for key, value in os.environ.items() if not key.startswith("GIT_")}, "GIT_NO_LAZY_FETCH": "1"}


def git(directory, *arguments, input=None, strict=False):
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *arguments],
        cwd=directory, input=input, capture_output=True, timeout=30,
        env=git_environment(),
    )
    require(result.returncode == 0, "git fixture/object operation failed")
    require(not strict or result.stderr == b"", "git object/checkout query emitted diagnostics")
    return result.stdout


def historical_control_input():
    # Only structured missing-object output without diagnostics is absence,
    # not corruption, a Git error or an incomplete checkout. Never fetch it.
    require(git(ROOT, "rev-parse", "--is-inside-work-tree", strict=True) == b"true\n", "historical controls require a working checkout")
    require(git(ROOT, "rev-parse", "--is-shallow-repository", strict=True) == b"false\n", "historical controls require a complete checkout")
    config = git(ROOT, "config", "--name-only", "--list", strict=True)
    keys = [line.partition(b"=")[0].lower() for line in config.splitlines()]
    require(not any(key == b"extensions.partialclone" or key.endswith((b".promisor", b".partialclonefilter")) for key in keys), "historical controls reject partial checkout ambiguity")
    identity = git(ROOT, "cat-file", "--batch-check=%(objectname) %(objecttype)", input=(COMMIT + "\n").encode(), strict=True)
    if identity == (COMMIT + " missing\n").encode():
        return None
    require(identity == (COMMIT + " commit\n").encode(), "historical object identity malformed")
    content = git(ROOT, "show", f"{COMMIT}:{FILE}")
    require(git(ROOT, "rev-parse", f"{COMMIT}:{FILE}").decode().strip() == BLOB, "historical blob identity changed")
    require(hashlib.sha256(content).hexdigest() == PATCH_SHA256, "historical patch identity changed")
    lines = content.splitlines()
    require(len(lines) >= LINE, "historical finding line missing")
    original = lines[LINE - 1]
    require(hashlib.sha256(original).hexdigest() == LINE_SHA256, "historical finding line identity changed")
    return original


def synthetic_control_input():
    # No historical finding can be suppressed when its immutable object is
    # absent. Still exercise every new-match control under the actual policy.
    value = hashlib.sha256(b"inert historical row scanner positive control").hexdigest()[:32].encode()
    return b'SERVICE_' + b'API_KEY = "' + value + b'"'


def validator_controls(work):
    policy = work / "policy-control"
    variants = [
        "", "malformed", ":".join(FINGERPRINT.split(":")[1:]),
        FINGERPRINT + "\n" + FINGERPRINT,
        FINGERPRINT + "\nother:entry", " " + FINGERPRINT,
    ]
    expect_rejected("absent exception", lambda: validate_ignore(policy))
    for index, text in enumerate(variants):
        policy.write_text(text + "\n", encoding="utf-8")
        expect_rejected(f"malformed/global/extra policy {index + 1}", lambda: validate_ignore(policy))
    policy.write_text("# provenance\n\n" + FINGERPRINT + "\n", encoding="utf-8")
    validate_ignore(policy)

    report = work / "report-control.json"
    identity = (COMMIT, FILE, RULE, LINE)
    expect_rejected("absent report", lambda: validate_report(1, report, [identity]))
    valid = dict(zip(("Commit", "File", "RuleID", "StartLine"), identity), Secret="REDACTED")
    bad_reports = ["not json", "{}", "[]", json.dumps([valid, valid]), json.dumps([{}])]
    for field, replacement in [("Commit", "wrong"), ("File", "wrong"), ("RuleID", "wrong"), ("StartLine", LINE + 1), ("Secret", "not-redacted")]:
        bad_reports.append(json.dumps([{**valid, field: replacement}]))
    for index, text in enumerate(bad_reports):
        report.write_text(text, encoding="utf-8")
        expect_rejected(f"invalid report {index + 1}", lambda: validate_report(1, report, [identity]))
    report.write_text(json.dumps([valid]), encoding="utf-8")
    validate_report(1, report, [identity])
    expect_rejected("execution error with valid report", lambda: validate_report(2, report, [identity]))
    expect_rejected("clean exit with finding", lambda: validate_report(0, report, [identity]))
    report.write_text("[]", encoding="utf-8")
    validate_report(0, report, [])
    expect_rejected("finding exit with clean report", lambda: validate_report(1, report, []))


def main(scanner):
    scanner = shutil.which(scanner) or str(Path(scanner).resolve())
    version = subprocess.run([scanner, "version"], capture_output=True, timeout=10, env=git_environment())
    require(version.returncode == 0 and version.stdout.strip() == b"8.21.2", "historical controls require CI-pinned Gitleaks 8.21.2")
    ignore = ROOT / ".gitleaksignore"
    validate_ignore(ignore)
    original = historical_control_input()
    historical_present = original is not None
    if not historical_present:
        print("AUDIT historical object=absent disposition=inert; no historical finding was scanned or suppressed")
        print("NOTICE historical row should be removed through independent cleanup review; no refs or policy changed")
        original = synthetic_control_input()
    # Recover or assemble only synthetic control input, never print it.
    tokens = list(re.finditer(rb"\b[A-Za-z0-9_-]{20,}\b", original))
    require(len(tokens) == 1, "historical synthetic token shape changed")
    token = tokens[0]
    value = token.group()
    adjacent = value[:-1] + (b"Q" if value[-1:] != b"Q" else b"R")
    modified = original[:token.start()] + adjacent + original[token.end():]

    scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR") or os.environ.get("RUNNER_TEMP")
    with tempfile.TemporaryDirectory(prefix="gitleaks-history-", dir=scratch) as directory:
        work = Path(directory)
        validator_controls(work)
        empty = work / "empty-ignore"
        empty.write_text("", encoding="utf-8")
        config = ROOT / ".gitleaks.toml"
        serial = 0

        def scan(label, mode, target, policy, expected, log_opts=None):
            nonlocal serial
            serial += 1
            report = work / f"scan-{serial}.json"
            args = [scanner, mode, ".", "--config", str(config), "--redact=100", "--no-banner", "--report-format", "json", "--report-path", str(report), "--gitleaks-ignore-path", str(policy)]
            if log_opts is not None:
                args += ["--log-opts", log_opts]
            result = subprocess.run(args, cwd=target, capture_output=True, timeout=60, env=git_environment())
            # Reports are parsed only after enforcing redaction of all captured data.
            data = result.stdout + result.stderr + (report.read_bytes() if report.exists() else b"")
            require(value not in data and adjacent not in data, "scanner exposed synthetic input")
            count = validate_report(result.returncode, report, expected)
            print(f"PASS  {label}: exit={result.returncode} findings={count}")
            return count

        if historical_present:
            # The pinned scanner ALSO loads source/.gitleaksignore, even with an
            # explicit empty --gitleaks-ignore-path. A local no-checkout clone
            # prevents the raw control from inheriting the repository exception.
            history = work / "history"
            git(work, "clone", "--shared", "--no-checkout", str(ROOT), str(history))
            identity = (COMMIT, FILE, RULE, LINE)
            commit_range = f"{COMMIT}^..{COMMIT}"
            raw = scan("historical raw positive control", "git", history, empty, [identity], commit_range)
            remaining = scan("historical exact disposition", "git", history, ignore, [], commit_range)
            print(f"AUDIT historical raw={raw} adjudicated={raw - remaining} unsuppressed={remaining}")
        fields = FINGERPRINT.split(":")
        for index, replacement in enumerate(["0" * 40, FILE + ".adjacent", RULE + "-adjacent", str(LINE + 1)]):
            changed = fields.copy()
            changed[index] = replacement
            policy = work / f"wrong-field-{index}"
            policy.write_text(":".join(changed) + "\n", encoding="utf-8")
            expect_rejected(f"wrong fingerprint field {index + 1}", lambda: validate_ignore(policy))
            if historical_present:
                scan(f"wrong fingerprint field {index + 1} restores detection", "git", history, policy, [identity], commit_range)

        def fixture(label, path, line, text, commit):
            target = work / label
            target.mkdir()
            file = target / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"\n" * (line - 1) + text + b"\n")
            sha = ""
            if commit:
                git(target, "init", "-b", "fixture")
                git(target, "add", "--", path)
                git(target, "-c", "user.name=Scanner self-test", "-c", "user.email=selftest@example.invalid", "commit", "-m", "test: synthetic scanner control")
                sha = git(target, "rev-parse", "HEAD").decode().strip()
            expected = [(sha, path, RULE, line)]
            scan(label, "git" if commit else "dir", target, ignore, expected)
            return target, expected

        same, same_identity = fixture("same-path-line-new-commit", FILE, LINE, original, True)
        fixture("adjacent-value-new-commit", FILE, LINE, modified, True)
        fixture("adjacent-path-new-commit", FILE + ".adjacent", LINE, original, True)
        fixture("adjacent-line-new-commit", FILE, LINE + 1, original, True)
        fixture("original-working-tree", FILE, LINE, original, False)
        fixture("modified-working-tree", FILE, LINE, modified, False)

        # Demonstrate the real scanner semantics of the dangerous global-key mutant.
        # The validator rejects it and the valid-policy new-commit control kills it.
        global_policy = work / "global-mutant"
        global_policy.write_text(":".join(fields[1:]) + "\n", encoding="utf-8")
        expect_rejected("commit-scope removal policy mutant", lambda: validate_ignore(global_policy))
        scan("global mutant demonstrates overbroad suppression", "git", same, global_policy, [])
        expect_rejected("new-commit control kills global mutant", lambda: validate_report(0, work / f"scan-{serial}.json", same_identity))
        print("historical scanner self-test passed; refs and scanner rules unchanged")


if __name__ == "__main__":
    try:
        main(sys.argv[1] if len(sys.argv) == 2 else "gitleaks")
    except SelfTestError as error:
        print(f"FAIL  {error}; no exception may be relied on")
        sys.exit(1)
    except (OSError, subprocess.SubprocessError):
        # Tool exceptions can include argv/output: never echo them or a traceback.
        print("FAIL  historical scanner tool execution; no exception may be relied on")
        sys.exit(1)
