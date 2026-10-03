#!/usr/bin/env python3
"""Deterministic offline tests for the TOG-13273 router_mix retune.

Covers: exact glm-5.3 match, positive numerator, weekday peak-window
boundaries (Mon-Fri 06:00-10:00Z edges), denial-gate combinations,
stale/missing data fail-closed, info retention on success, Muse alias
classification, and removal of the fallbackOnly failure mode.

Run:  python3 docs/operator/TOG-13273-router-mix-test.py
No network, no database, no credentials.
"""
import datetime as dt
import importlib.util
import sys
import unittest
from pathlib import Path

UTC = dt.timezone.utc
ART_PATH = Path(__file__).with_name("TOG-13273-router-mix-detector.py")


def load_artifact():
    spec = importlib.util.spec_from_file_location("tog13273_detector", ART_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ART = load_artifact()


def T(year, month, day, hour, minute=0, second=0):
    return dt.datetime(year, month, day, hour, minute, second, tzinfo=UTC)


# 2026-10-05 is a Monday, 2026-10-09 a Friday, 2026-10-03 a Saturday.
MON_0559 = T(2026, 10, 5, 5, 59, 59)
MON_0600 = T(2026, 10, 5, 6, 0, 0)
TUE_0730 = T(2026, 10, 6, 7, 30, 0)
FRI_0959 = T(2026, 10, 9, 9, 59, 59)
FRI_1000 = T(2026, 10, 9, 10, 0, 0)
SAT_0800 = T(2026, 10, 3, 8, 0, 0)
SUN_0800 = T(2026, 10, 4, 8, 0, 0)


class Harness:
    """Stub host plumbing (q/qj/emit) around the artifact module."""

    def __init__(self, ledger, models, mix_rows, share_rows, error_on=None):
        self.ledger = ledger
        self.models = models
        self.mix_rows = mix_rows
        self.share_rows = share_rows
        self.error_on = error_on or set()
        self.emitted = []

    def install(self):
        ART.qj = self.fake_qj
        ART.q = self.fake_q
        ART.emit = self.fake_emit

    def fake_qj(self, sql):
        if "qj" in self.error_on:
            raise RuntimeError("qj boom")
        if "laneLedger" in sql:
            return self.ledger
        return self.models

    def fake_q(self, sql):
        if "q" in self.error_on:
            raise RuntimeError("q boom")
        if "5 hours" in sql:
            return self.share_rows
        return self.mix_rows

    def fake_emit(self, name, ok, msg):
        self.emitted.append((name, ok, msg))

    def run(self, now):
        self.install()
        ART.router_mix(now_utc=now)
        assert len(self.emitted) == 1, "emit must fire exactly once, got %d" % len(self.emitted)
        return self.emitted[0]


def ledger_of(zai_verdict=None, extra=None):
    ledger = {"cliproxy-zai": {"verdict": dict(zai_verdict or {})}}
    ledger.update(extra or {})
    return ledger


BEHIND = {"state": "behind", "serviceable": True}
DENIED_LEDGER = ledger_of({"laneHasRoom": False})
ROOM_LEDGER = ledger_of({"laneHasRoom": True})
QUIET_LEDGER = ledger_of({})
SHARE_LOW = [(0, 100)]
SHARE_HIGH = [(60, 100)]


class NumeratorTest(unittest.TestCase):
    def test_exact_model_match_counts_only_glm_5_3(self):
        mix = [("glm-5.3", 1), ("glm-5.3-flash", 2), ("glm-5.30", 3),
               ("GLM-5.3", 4), ("xglm-5.3", 5), ("muse-canary-1", 6)]
        _, ok, msg = Harness(QUIET_LEDGER, [], mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("numerator 1/21", msg)

    def test_positive_numerator_passes_with_muse_volume(self):
        mix = [("muse-canary-1", 50), ("glm-5.3", 1)]
        _, ok, msg = Harness(QUIET_LEDGER, [], mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("1/51", msg)
        self.assertNotIn("fallbackOnly", msg)

    def test_zero_outside_window_fails_on_numerator(self):
        mix = [("muse-canary-1", 40)]
        _, ok, msg = Harness(DENIED_LEDGER, [], mix, SHARE_LOW).run(SUN_0800)
        self.assertFalse(ok, msg)
        self.assertIn("outside peak allowance", msg)
        self.assertNotIn("fallbackOnly", msg)

    def test_behind_lane_is_info_not_failure(self):
        extra = {"cliproxy-claude": {"verdict": dict(BEHIND)}}
        mix = [("claude-x", 35)]
        _, ok, msg = Harness(ledger_of(dict(BEHIND), extra), [], mix, SHARE_LOW).run(SUN_0800)
        self.assertFalse(ok, msg)
        self.assertIn("numerator 0/35", msg)
        self.assertIn("pace=behind", msg)
        self.assertNotIn("but 0/35 runs in 60m", msg.split("INFO:")[0])


class PeakWindowTest(unittest.TestCase):
    def test_peak_boundaries(self):
        cases = [
            (MON_0559, False), (MON_0600, True), (TUE_0730, True),
            (FRI_0959, True), (FRI_1000, False),
            (SAT_0800, False), (SUN_0800, False),
        ]
        for now, want_ok in cases:
            with self.subTest(now=now.isoformat()):
                _, ok, _ = Harness(DENIED_LEDGER, [], [], SHARE_LOW).run(now)
                self.assertEqual(ok, want_ok, "now=%s" % now.isoformat())


class DenialGateTest(unittest.TestCase):
    def run_zero(self, ledger, share, now=TUE_0730):
        return Harness(ledger, [], [], share).run(now)

    def test_resolved_false_passes(self):
        _, ok, msg = self.run_zero(DENIED_LEDGER, SHARE_LOW)
        self.assertTrue(ok, msg)
        self.assertIn("peak allowance", msg)
        self.assertIn("laneHasRoom=false", msg)

    def test_resolved_true_fails(self):
        _, ok, msg = self.run_zero(ROOM_LEDGER, SHARE_LOW)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_no_evidence_fails(self):
        _, ok, _ = self.run_zero(QUIET_LEDGER, SHARE_LOW)
        self.assertFalse(ok)

    def test_pace_gate_markers_pass(self):
        for marker in (False, "closed", "exhausted", "deny", "denied"):
            with self.subTest(marker=marker):
                _, ok, msg = self.run_zero(ledger_of({"paceGate": marker}), SHARE_LOW)
                self.assertTrue(ok, "marker=%r msg=%s" % (marker, msg))
                self.assertIn("pace gate", msg)

    def test_peak_cap_marker_passes_only_in_window(self):
        ledger = ledger_of({"peakCapped": True})
        _, ok, _ = self.run_zero(ledger, SHARE_LOW, now=TUE_0730)
        self.assertTrue(ok)
        _, ok, _ = self.run_zero(ledger, SHARE_LOW, now=SUN_0800)
        self.assertFalse(ok)

    def test_five_hour_share_cutoff(self):
        _, ok, msg = self.run_zero(QUIET_LEDGER, [(50, 100)])
        self.assertTrue(ok, msg)
        self.assertIn("5h share 50/100", msg)
        _, ok, _ = self.run_zero(QUIET_LEDGER, [(49, 100)])
        self.assertFalse(ok)
        _, ok, _ = self.run_zero(QUIET_LEDGER, [(0, 0)])
        self.assertFalse(ok)

    def test_denied_outside_window_still_fails(self):
        _, ok, msg = self.run_zero(DENIED_LEDGER, SHARE_HIGH, now=SUN_0800)
        self.assertFalse(ok, msg)
        self.assertIn("outside peak allowance", msg)


class FailClosedTest(unittest.TestCase):
    def test_missing_inputs_fail(self):
        for ledger, mix, share in [
            (None, [], SHARE_LOW),
            ({}, [], SHARE_LOW),
            ([], [], SHARE_LOW),
            (QUIET_LEDGER, None, SHARE_LOW),
            (QUIET_LEDGER, [], None),
            (QUIET_LEDGER, [], []),
            (QUIET_LEDGER, [], [(1,)]),
        ]:
            with self.subTest(ledger=ledger, mix=mix, share=share):
                _, ok, msg = Harness(ledger, [], mix, share).run(TUE_0730)
                self.assertFalse(ok, msg)
                self.assertTrue(msg.startswith("FAIL: detector data"),
                                "fail-closed message expected, got: %s" % msg)

    def test_query_error_fails(self):
        _, ok, msg = Harness(QUIET_LEDGER, [], [], SHARE_LOW, error_on={"q"}).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("missing/stale", msg)


class InfoRetentionTest(unittest.TestCase):
    def test_info_on_numerator_success(self):
        extra = {"cliproxy-claude": {"verdict": dict(BEHIND)}}
        mix = [("glm-5.3", 2), ("claude-x", 10)]
        _, ok, msg = Harness(ledger_of(dict(BEHIND), extra), [], mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("cliproxy-zai pace=behind (2/12 runs in 60m)", msg)
        self.assertIn("cliproxy-claude pace=behind (10/12 runs in 60m)", msg)

    def test_info_on_peak_allowance_success(self):
        extra = {"cliproxy-claude": {"verdict": dict(BEHIND)}}
        _, ok, msg = Harness(ledger_of({}, extra), [], [("claude-x", 10)], SHARE_LOW).run(TUE_0730)
        # resolved laneHasRoom absent and share low -> this FAILs; info must survive failure too
        self.assertFalse(ok, msg)
        self.assertIn("cliproxy-claude pace=behind (10/10 runs in 60m)", msg)
        ledger = ledger_of({"laneHasRoom": False}, extra)
        _, ok, msg = Harness(ledger, [], [("claude-x", 10)], SHARE_LOW).run(TUE_0730)
        self.assertTrue(ok, msg)
        self.assertIn("cliproxy-claude pace=behind (10/10 runs in 60m)", msg)


class ClassificationTest(unittest.TestCase):
    def test_lane_mapping(self):
        cases = {
            "devin/abc": "cliproxy-devin",
            "claude-opus-4-5": "cliproxy-claude",
            "gpt-5.x": "cliproxy-codex",
            "codex-mini": "cliproxy-codex",
            "glm-5.3": "cliproxy-zai",
            "glm-5.3-flash": "cliproxy-zai",
            "muse-canary-7": "cliproxy-meta",
            "muse-spark": "cliproxy-meta",
            "grok-4": "cliproxy-xai",
            "kimi-k2": "cliproxy-kimi",
            "other-model": "other",
        }
        for model, lane in cases.items():
            with self.subTest(model=model):
                self.assertEqual(ART._classify_lane(model), lane)


class RegressionTest(unittest.TestCase):
    def test_no_fallbackonly_failure(self):
        models = [{"model": "muse-x", "fallbackOnly": True}, {"model": "glm-5.3"}]
        mix = [("muse-x", 25), ("glm-5.3", 2)]
        _, ok, msg = Harness(QUIET_LEDGER, models, mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertNotIn("fallbackOnly", msg)

    def test_emit_contract(self):
        h = Harness(QUIET_LEDGER, [], [("glm-5.3", 1)], SHARE_LOW)
        name, ok, msg = h.run(SUN_0800)
        self.assertEqual(name, "platform_router-mix")
        self.assertTrue(ok)
        self.assertTrue(isinstance(msg, str) and len(msg) > 0)
        self.assertNotIn("file card", msg)
        h = Harness(QUIET_LEDGER, [], [], SHARE_LOW)
        _, ok, msg = h.run(SUN_0800)
        self.assertFalse(ok)
        self.assertIn("file card", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
