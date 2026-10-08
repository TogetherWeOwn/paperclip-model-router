"""Fast policy/orchestration regressions; real scanner semantics run in its CI job."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("history", Path(__file__).with_name("gitleaks-history-selftest.py"))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class HistoricalInputTests(unittest.TestCase):
    def test_absent_object_is_explicit_and_does_not_read_or_fetch_it(self):
        with patch.object(history, "git", side_effect=[b"true\n", b"false\n", b"",(history.COMMIT + " missing\n").encode()]) as git:
            self.assertIsNone(history.historical_control_input())
        self.assertEqual(git.call_count, 4)
        self.assertTrue(all(call.kwargs["strict"] for call in git.call_args_list))
        self.assertEqual(git.call_args.args[1:], ("cat-file", "--batch-check=%(objectname) %(objecttype)"))
        self.assertEqual(git.call_args.kwargs["input"], (history.COMMIT + "\n").encode())

    def test_shallow_checkout_fails_before_object_lookup(self):
        with patch.object(history, "git", return_value=b"true\n") as git:
            with self.assertRaisesRegex(history.SelfTestError, "complete checkout"):
                history.historical_control_input()
        self.assertEqual(git.call_count, 2)

    def test_partial_checkout_markers_fail_before_object_lookup(self):
        for config in [b"extensions.partialClone=origin\n", b"remote.origin.promisor=true\n", b"remote.origin.partialclonefilter=blob:none\n"]:
            with self.subTest(config=config), patch.object(history, "git", side_effect=[b"true\n", b"false\n", config]) as git:
                with self.assertRaisesRegex(history.SelfTestError, "partial checkout ambiguity"):
                    history.historical_control_input()
                self.assertEqual(git.call_count, 3)

    def test_git_timeout_or_launch_error_does_not_enter_inert_mode(self):
        for error in [subprocess.TimeoutExpired("git", 30), OSError("fixture launch error")]:
            with self.subTest(error=type(error).__name__), patch.object(history.subprocess, "run", side_effect=error):
                with self.assertRaises(type(error)):
                    history.historical_control_input()

    def test_git_error_is_not_absence(self):
        with patch.object(history, "git", side_effect=[b"true\n", b"false\n", b"",history.SelfTestError("git fixture/object operation failed")]):
            with self.assertRaisesRegex(history.SelfTestError, "operation failed"):
                history.historical_control_input()

    def test_noncommit_or_malformed_object_output_fails(self):
        for output in [b"", b"missing\n", (history.COMMIT + " blob\n").encode(), (history.COMMIT + " missing\nextra\n").encode()]:
            with self.subTest(output=output), patch.object(history, "git", side_effect=[b"true\n", b"false\n", b"",output]):
                with self.assertRaisesRegex(history.SelfTestError, "identity malformed"):
                    history.historical_control_input()

    def test_present_object_still_checks_blob_patch_and_line(self):
        content = b"synthetic provenance line\n"
        responses = [b"true\n", b"false\n", b"", (history.COMMIT + " commit\n").encode(), content, (history.BLOB + "\n").encode()]
        with patch.multiple(history, LINE=1, PATCH_SHA256=hashlib.sha256(content).hexdigest(), LINE_SHA256=hashlib.sha256(content.rstrip(b"\n")).hexdigest()):
            with patch.object(history, "git", side_effect=responses):
                self.assertEqual(history.historical_control_input(), content.rstrip(b"\n"))
            for field in ["BLOB", "PATCH_SHA256", "LINE_SHA256"]:
                with self.subTest(field=field), patch.object(history, field, "changed"), patch.object(history, "git", side_effect=responses):
                    with self.assertRaises(history.SelfTestError):
                        history.historical_control_input()

    def test_git_disables_lazy_fetch_and_keeps_error_output_private(self):
        overrides = {key: "caller override" for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]}
        with patch.dict(os.environ, overrides), patch.object(history.subprocess, "run", return_value=subprocess.CompletedProcess([], 128, b"", b"private diagnostic")) as run:
            with self.assertRaisesRegex(history.SelfTestError, "^git fixture/object operation failed$"):
                history.git(history.ROOT, "cat-file", "--batch-check", input=b"object\n")
        self.assertEqual(run.call_args.kwargs["env"]["GIT_NO_LAZY_FETCH"], "1")
        self.assertTrue(all(key not in run.call_args.kwargs["env"] for key in overrides))
        self.assertEqual(run.call_args.kwargs["input"], b"object\n")

    def test_inherited_git_dir_cannot_change_caller_refs_or_index(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR") or os.environ.get("RUNNER_TEMP")
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        with tempfile.TemporaryDirectory(prefix="git-isolation-test-", dir=scratch) as directory:
            caller = Path(directory) / "caller"
            fixture = Path(directory) / "fixture"
            caller.mkdir()
            fixture.mkdir()
            def caller_git(*args):
                result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *args], cwd=caller, env=env, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0)
                return result.stdout
            caller_git("init", "-b", "main")
            (caller / "kept.txt").write_text("caller content\n", encoding="utf-8")
            caller_git("add", ".")
            caller_git("-c", "user.name=Scanner self-test", "-c", "user.email=selftest@example.invalid", "commit", "-m", "test: protected caller")
            (caller / "kept.txt").write_text("staged caller content\n", encoding="utf-8")
            caller_git("add", ".")
            before = (caller_git("rev-parse", "HEAD"), caller_git("show-ref"), (caller / ".git" / "index").read_bytes())
            (fixture / "fixture.txt").write_text("fixture content\n", encoding="utf-8")
            with patch.dict(os.environ, {"GIT_DIR": str(caller / ".git")}):
                history.git(fixture, "init", "-b", "fixture")
                history.git(fixture, "add", ".")
                history.git(fixture, "-c", "user.name=Scanner self-test", "-c", "user.email=selftest@example.invalid", "commit", "-m", "test: isolated fixture")
                self.assertEqual(history.git(fixture, "ls-tree", "--name-only", "HEAD"), b"fixture.txt\n")
            after = (caller_git("rev-parse", "HEAD"), caller_git("show-ref"), (caller / ".git" / "index").read_bytes())
            self.assertEqual(after, before)


class AbsentHistoryFlowTests(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR") or os.environ.get("RUNNER_TEMP")
        self.directory = tempfile.TemporaryDirectory(prefix="history-flow-test-", dir=scratch)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / ".gitleaksignore").write_text(history.FINGERPRINT + "\n", encoding="utf-8")
        (self.root / ".gitleaks.toml").write_text("[extend]\nuseDefault = true\n", encoding="utf-8")
        history.git(self.root, "init", "-b", "main")
        history.git(self.root, "add", ".")
        history.git(self.root, "-c", "user.name=Scanner self-test", "-c", "user.email=selftest@example.invalid", "commit", "-m", "test: squash-shaped fixture")
        self.real_run = subprocess.run
        self.scans = []

    def scanner_run(self, args, **kwargs):
        if Path(args[0]).name != "scanner-control":
            return self.real_run(args, **kwargs)
        if args[1:] == ["version"]:
            return subprocess.CompletedProcess(args, 0, b"8.21.2\n", b"")
        target = Path(kwargs["cwd"])
        mode = args[1]
        files = [file for file in target.rglob("*") if file.is_file() and ".git" not in file.relative_to(target).parts]
        self.assertEqual(len(files), 1)
        file = files[0]
        path = file.relative_to(target).as_posix()
        line = next(index for index, text in enumerate(file.read_bytes().splitlines(), 1) if text)
        commit = history.git(target, "rev-parse", "HEAD").decode().strip() if mode == "git" else ""
        identity = (commit, path, history.RULE, line)
        policy = Path(args[args.index("--gitleaks-ignore-path") + 1]).read_text().strip()
        suppressed = policy in [":".join(map(str, identity)), ":".join(map(str, identity[1:]))]
        findings = [] if suppressed else [dict(zip(("Commit", "File", "RuleID", "StartLine"), identity), Secret="REDACTED")]
        report = Path(args[args.index("--report-path") + 1])
        report.write_text(json.dumps(findings), encoding="utf-8")
        self.scans.append((mode, path, line, len(findings)))
        return subprocess.CompletedProcess(args, 0 if suppressed else 1, b"", b"")

    def run_main(self):
        output = io.StringIO()
        with patch.object(history, "ROOT", self.root), patch.object(history.subprocess, "run", side_effect=self.scanner_run), contextlib.redirect_stdout(output):
            history.main("scanner-control")
        return output.getvalue()

    def test_main_only_checkout_keeps_all_nonhistorical_controls_and_refs(self):
        before = history.git(self.root, "show-ref")
        output = self.run_main()
        self.assertEqual(history.git(self.root, "show-ref"), before)
        self.assertEqual(len(self.scans), 7)
        self.assertEqual([scan[3] for scan in self.scans], [1, 1, 1, 1, 1, 1, 0])
        self.assertEqual([scan[0] for scan in self.scans], ["git"] * 4 + ["dir"] * 2 + ["git"])
        self.assertIn("object=absent disposition=inert", output)
        self.assertIn("row should be removed", output)
        self.assertNotIn("historical raw=", output)
        self.assertIn("invalid report 10: rejected", output)
        self.assertIn("wrong fingerprint field 4: rejected", output)
        self.assertIn("new-commit control kills global mutant: rejected", output)

    def test_real_corrupt_loose_object_is_not_absence(self):
        object_file = self.root / ".git" / "objects" / history.COMMIT[:2] / history.COMMIT[2:]
        object_file.parent.mkdir(exist_ok=True)
        object_file.write_bytes(b"invalid loose object control")
        probe = self.real_run(
            ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
            input=(history.COMMIT + "\n").encode(), cwd=self.root,
            capture_output=True, env=history.git_environment(), timeout=30,
        )
        self.assertEqual(probe.returncode, 0)
        self.assertEqual(probe.stdout, (history.COMMIT + " missing\n").encode())
        self.assertNotEqual(probe.stderr, b"")
        with patch.object(history, "ROOT", self.root):
            with self.assertRaisesRegex(history.SelfTestError, "emitted diagnostics"):
                history.historical_control_input()

    def test_real_partial_marker_is_not_absence(self):
        normal_git = history.git
        def inherited_config(directory, *args, **kwargs):
            return normal_git(directory, "-c", "remote.control.promisor=true", *args, **kwargs)
        with patch.object(history, "git", side_effect=inherited_config), patch.object(history, "ROOT", self.root):
            with self.assertRaisesRegex(history.SelfTestError, "partial checkout ambiguity"):
                history.historical_control_input()
        history.git(self.root, "config", "remote.origin.promisor", "true")
        with patch.object(history, "ROOT", self.root):
            with self.assertRaisesRegex(history.SelfTestError, "partial checkout ambiguity"):
                history.historical_control_input()

    def test_non_repository_is_not_absence(self):
        with patch.object(history, "ROOT", self.root.parent):
            with self.assertRaisesRegex(history.SelfTestError, "operation failed"):
                history.historical_control_input()

    def test_absent_object_cannot_bypass_wrong_scanner_version(self):
        with patch.object(history, "ROOT", self.root), patch.object(history.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"8.21.1\n", b"")):
            with self.assertRaisesRegex(history.SelfTestError, "CI-pinned"):
                history.main("scanner-control")

    def test_absent_object_cannot_bypass_invalid_policy(self):
        for content in ["", history.FINGERPRINT + "\n" + history.FINGERPRINT, ":".join(history.FINGERPRINT.split(":")[1:])]:
            with self.subTest(content=content):
                (self.root / ".gitleaksignore").write_text(content, encoding="utf-8")
                with self.assertRaisesRegex(history.SelfTestError, "exactly the authorized"):
                    self.run_main()
        self.assertEqual(self.scans, [])

    def assert_scan_failure(self, returncode, message):
        def broken_scan(args, **kwargs):
            if Path(args[0]).name == "scanner-control" and args[1] != "version":
                return subprocess.CompletedProcess(args, returncode, b"", b"")
            return self.scanner_run(args, **kwargs)
        with patch.object(history, "ROOT", self.root), patch.object(history.subprocess, "run", side_effect=broken_scan), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(history.SelfTestError, message):
                history.main("scanner-control")

    def test_absent_object_cannot_bypass_scanner_error(self):
        self.assert_scan_failure(2, "scanner execution failed")

    def test_absent_object_cannot_bypass_missing_report(self):
        self.assert_scan_failure(1, "report missing or malformed")


if __name__ == "__main__":
    unittest.main()
