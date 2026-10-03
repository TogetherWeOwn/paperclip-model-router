#!/usr/bin/env python3
"""Deterministic offline tests for the TOG-13279 router_mix retune + emit integration.

Covers: exact glm-5.3 match, positive numerator, weekday peak-window
boundaries (Mon-Fri 06:00-10:00Z edges), denial-gate legs against the REAL
deployed schema (weekly pace gate / named 5h window / peak pin cap /
telemetry share), explicit-room veto over telemetry, serviceable-is-not-room,
malformed-ledger hardening (truthy non-dict entries), qj AND q error paths,
override/ pacing-config handling, pin model resolution, emit-wrapper
compatibility, info retention on success, Muse alias classification, and
removal of the fallbackOnly failure mode.

Run:  python3 docs/operator/TOG-13279-router-mix-test.py
No network, no database, no credentials.
"""
import contextlib
import datetime as dt
import importlib.util
import io
import sys
import unittest
from pathlib import Path

UTC = dt.timezone.utc
HERE = Path(__file__).parent
ART_PATH = HERE / "TOG-13279-router-mix-detector.py"
EMIT_PATH = HERE / "TOG-13279-emit-integration.py"


def load_detector():
    spec = importlib.util.spec_from_file_location("tog13279_detector", ART_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_emit_wrapper(before_emit):
    spec = importlib.util.spec_from_file_location("tog13279_emit", EMIT_PATH)
    mod = importlib.util.module_from_spec(spec)
    mod.emit = before_emit  # BEFORE emit in module scope, as on the host
    spec.loader.exec_module(mod)
    return mod


ART = load_detector()


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

FAR_FUTURE = "2030-01-01T00:00:00Z"  # elapsed ~= 0 against any test `now`
LONG_PAST = "2020-01-01T00:00:00Z"   # elapsed ~= 1 against any test `now`


_PINS_DEFAULT = object()


class Harness:
    """Stub host plumbing (q/qj/emit) around the artifact module."""

    def __init__(self, ledger, models, mix_rows, share_rows, pins_rows=_PINS_DEFAULT,
                 pacing=None, override=None, error_on=None):
        self.ledger = ledger
        self.models = models
        self.mix_rows = mix_rows
        self.share_rows = share_rows
        # Default (omitted) = no active pins; explicit None = pins read returned
        # NULL (missing telemetry -> fail closed).
        self.pins_rows = [] if pins_rows is _PINS_DEFAULT else pins_rows
        self.pacing = pacing
        self.override = override
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
        if "zaiPaceOverride" in sql:
            return self.override
        if "'pacing'" in sql:
            return self.pacing
        return self.models

    def fake_q(self, sql):
        if "q" in self.error_on:
            raise RuntimeError("q boom")
        if "assignee_adapter_overrides" in sql:
            return self.pins_rows
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


# ---- real-schema fixtures (LaneLedgerEntry.observation / PaceWindowObservation) ----

def obs_window(name, utilization, resets_at=FAR_FUTURE):
    return {"name": name, "role": "allowance", "utilization": utilization,
            "resetsAt": resets_at, "windowSeconds": 18000, "sourcePath": None}


def obs_account(windows, health="healthy", key="acc-1"):
    return {"accountKey": key, "health": health, "weight": 1.0,
            "weightSource": "reported", "governingWindow": None, "windows": list(windows)}


def zai_observation(windows, health="healthy"):
    return {"laneId": "cliproxy-zai", "free": False, "observedAt": "2026-10-03T11:58:25Z",
            "staleAfterSeconds": 900, "accounts": [obs_account(windows, health)], "error": None}


def ledger_with_obs(windows, health="healthy", verdict=None, extra=None):
    base_verdict = {"state": "on", "serviceable": True, "reason": "ok",
                    "score": None, "accounts": [], "observedAt": "2026-10-03T11:58:25Z",
                    "serviceableAccountCount": 1}
    if verdict is not None:
        base_verdict = dict(verdict)
    ledger = {"cliproxy-zai": {"laneId": "cliproxy-zai", "verdict": base_verdict,
                               "observation": zai_observation(windows, health),
                               "fetchedAt": "2026-10-03T11:58:25Z", "error": None}}
    ledger.update(extra or {})
    return ledger


def weekly_five_room():
    return [obs_window("weekly", 0.05), obs_window("five-hour", 0.10)]


def weekly_closed_five_low():
    return [obs_window("weekly", 0.90), obs_window("five-hour", 0.10)]


ROOM_LEDGER = ledger_with_obs(weekly_five_room())
WEEKLY_DENIED_LEDGER = ledger_with_obs(weekly_closed_five_low())
NO_OBS_LEDGER = {"cliproxy-zai": {"laneId": "cliproxy-zai",
                                  "verdict": {"state": "on", "serviceable": True, "reason": "ok"}}}

ZAI_ROSTER = [{"id": "glm-5.3", "laneId": "cliproxy-zai", "costPerMTokIn": 2.0, "costPerMTokOut": 8.0}]
FLASH_ROSTER = ZAI_ROSTER + [{"id": "glm-4-flash", "laneId": "cliproxy-zai",
                              "costPerMTokIn": 0.2, "costPerMTokOut": 0.4}]

SHARE_LOW = [(0, 100)]
SHARE_HIGH = [(60, 100)]
BEHIND_VERDICT = {"state": "behind", "serviceable": True, "reason": "ok"}


class NumeratorTest(unittest.TestCase):
    def test_exact_model_match_counts_only_glm_5_3(self):
        mix = [("glm-5.3", 1), ("glm-5.3-flash", 2), ("glm-5.30", 3),
               ("GLM-5.3", 4), ("xglm-5.3", 5), ("muse-canary-1", 6)]
        _, ok, msg = Harness(NO_OBS_LEDGER, ZAI_ROSTER, mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("numerator 1/21", msg)

    def test_positive_numerator_passes_with_muse_volume(self):
        mix = [("muse-canary-1", 50), ("glm-5.3", 1)]
        _, ok, msg = Harness(NO_OBS_LEDGER, ZAI_ROSTER, mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("1/51", msg)
        self.assertNotIn("fallbackOnly", msg)

    def test_zero_outside_window_fails_on_numerator(self):
        mix = [("muse-canary-1", 40)]
        _, ok, msg = Harness(WEEKLY_DENIED_LEDGER, ZAI_ROSTER, mix, SHARE_LOW).run(SUN_0800)
        self.assertFalse(ok, msg)
        self.assertIn("outside peak allowance", msg)
        self.assertNotIn("fallbackOnly", msg)


class PeakWindowTest(unittest.TestCase):
    def test_peak_boundaries(self):
        cases = [
            (MON_0559, False), (MON_0600, True), (TUE_0730, True),
            (FRI_0959, True), (FRI_1000, False),
            (SAT_0800, False), (SUN_0800, False),
        ]
        for now, want_ok in cases:
            with self.subTest(now=now.isoformat()):
                _, ok, _ = Harness(WEEKLY_DENIED_LEDGER, ZAI_ROSTER, [], SHARE_LOW).run(now)
                self.assertEqual(ok, want_ok, "now=%s" % now.isoformat())


class WeeklyGateTest(unittest.TestCase):
    def run_zero(self, ledger, share, models=None, pins=_PINS_DEFAULT, pacing=None, override=None, now=TUE_0730):
        return Harness(ledger, ZAI_ROSTER if models is None else models, [], share,
                       pins_rows=pins, pacing=pacing, override=override).run(now)

    def test_weekly_closed_passes(self):
        _, ok, msg = self.run_zero(WEEKLY_DENIED_LEDGER, SHARE_LOW)
        self.assertTrue(ok, msg)
        self.assertIn("peak allowance", msg)
        self.assertIn("weekly pace gate closed", msg)

    def test_weekly_open_with_room_fails(self):
        _, ok, msg = self.run_zero(ROOM_LEDGER, SHARE_LOW)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_room_vetoes_high_telemetry_share(self):
        # Explicit deployed room evidence contradicts the telemetry proxy: must FAIL.
        _, ok, msg = self.run_zero(ROOM_LEDGER, SHARE_HIGH)
        self.assertFalse(ok, "room must veto telemetry, got: %s" % msg)
        self.assertIn("lane has room", msg)

    def test_elapsed_week_reopens_gate(self):
        # Window resetting now: elapsed ~= 1, so 0.90 <= 1 + 0.15 -> open -> room -> FAIL.
        ledger = ledger_with_obs([obs_window("weekly", 0.90, LONG_PAST), obs_window("five-hour", 0.10)])
        _, ok, msg = self.run_zero(ledger, SHARE_LOW)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_missing_weekly_window_abstains(self):
        # No weekly window at all: the gate abstains (no evidence either way),
        # so explicit room cannot be established -> fail closed with the
        # no-evidence message, never a crash and never a silent pass.
        ledger = ledger_with_obs([obs_window("five-hour", 0.10)])
        _, ok, msg = self.run_zero(ledger, SHARE_LOW)
        self.assertFalse(ok, msg)
        self.assertIn("FAIL: pinned zai numerator", msg)
        self.assertNotIn("peak allowance", msg)

    def test_active_override_tightens_margin(self):
        # Live override margin 0.0 active into the future: 0.05 > 0 + 0 -> closed -> pass.
        override = {"margin": 0.0, "until": "2030-01-01T00:00:00Z"}
        _, ok, msg = self.run_zero(ROOM_LEDGER, SHARE_LOW, override=override)
        self.assertTrue(ok, msg)
        self.assertIn("weekly pace gate closed", msg)

    def test_expired_override_falls_back_to_default(self):
        override = {"margin": 0.0, "until": "2020-01-01T00:00:00Z"}
        _, ok, msg = self.run_zero(ROOM_LEDGER, SHARE_LOW, override=override)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_malformed_override_uses_default_margin(self):
        _, ok, _ = self.run_zero(ROOM_LEDGER, SHARE_LOW, override={"margin": "lots"})
        self.assertFalse(ok)


class FiveHourWindowTest(unittest.TestCase):
    def test_named_5h_high_passes(self):
        ledger = ledger_with_obs([obs_window("weekly", 0.05), obs_window("five-hour", 0.70)])
        _, ok, msg = Harness(ledger, ZAI_ROSTER, [], SHARE_LOW).run(TUE_0730)
        self.assertTrue(ok, msg)
        self.assertIn("five-hour", msg)

    def test_5h_reads_max_over_healthy_only(self):
        # Unhealthy account at 0.9 must not deny; healthy at 0.1 -> room -> FAIL.
        obs = zai_observation([obs_window("weekly", 0.05), obs_window("five-hour", 0.10)])
        obs["accounts"].append(obs_account([obs_window("five-hour", 0.90)], health="exhausted", key="acc-2"))
        ledger = {"cliproxy-zai": {"laneId": "cliproxy-zai", "verdict": dict(BEHIND_VERDICT),
                                   "observation": obs, "fetchedAt": "x", "error": None}}
        _, ok, msg = Harness(ledger, ZAI_ROSTER, [], SHARE_LOW).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_telemetry_share_cutoff_without_observation(self):
        _, ok, msg = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], [(50, 100)]).run(TUE_0730)
        self.assertTrue(ok, msg)
        self.assertIn("5h share 50/100", msg)
        _, ok, _ = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], [(49, 100)]).run(TUE_0730)
        self.assertFalse(ok)
        _, ok, _ = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], [(0, 0)]).run(TUE_0730)
        self.assertFalse(ok)

    def test_no_evidence_fails(self):
        _, ok, msg = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], SHARE_LOW).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("no positive denial evidence", msg)

    def test_denied_outside_window_still_fails(self):
        _, ok, msg = Harness(WEEKLY_DENIED_LEDGER, ZAI_ROSTER, [], SHARE_HIGH).run(SUN_0800)
        self.assertFalse(ok, msg)
        self.assertIn("outside peak allowance", msg)


class PinCapTest(unittest.TestCase):
    def test_peak_pin_cap_reached_passes(self):
        # In-window cap is 1/account x 1 healthy account; one full-weight pin denies.
        pins = [{"pinned_model": "glm-5.3"}]
        _, ok, msg = Harness(ROOM_LEDGER, ZAI_ROSTER, [], SHARE_LOW, pins_rows=pins).run(TUE_0730)
        self.assertTrue(ok, msg)
        self.assertIn("pin cap", msg)

    def test_pins_below_cap_show_room(self):
        _, ok, msg = Harness(ROOM_LEDGER, ZAI_ROSTER, [], SHARE_LOW, pins_rows=[]).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_flash_pins_count_half_weight(self):
        # Two flash pins = 1.0 slot: reaches the in-window cap of 1 -> deny.
        pins = [{"pinned_model": "glm-4-flash"}, {"pinned_model": "glm-4-flash"}]
        _, ok, _ = Harness(ROOM_LEDGER, FLASH_ROSTER, [], SHARE_LOW, pins_rows=pins).run(TUE_0730)
        self.assertTrue(ok)
        # A single flash pin = 0.5 slot: below cap -> room -> FAIL.
        _, ok, _ = Harness(ROOM_LEDGER, FLASH_ROSTER, [], SHARE_LOW,
                           pins_rows=[{"pinned_model": "glm-4-flash"}]).run(TUE_0730)
        self.assertFalse(ok)

    def test_legacy_cliproxy_prefix_resolves(self):
        pins = [{"pinned_model": "cliproxy/glm-5.3"}]
        _, ok, _ = Harness(ROOM_LEDGER, ZAI_ROSTER, [], SHARE_LOW, pins_rows=pins).run(TUE_0730)
        self.assertTrue(ok)

    def test_suffix_guess_does_not_resolve(self):
        # zai/glm-5.3 is a distinct routable model, never a suffix guess: pin skipped -> room.
        pins = [{"pinned_model": "zai/glm-5.3"}]
        _, ok, msg = Harness(ROOM_LEDGER, ZAI_ROSTER, [], SHARE_LOW, pins_rows=pins).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("lane has room", msg)

    def test_other_lane_pins_ignored(self):
        roster = ZAI_ROSTER + [{"id": "claude-opus-4-5", "laneId": "cliproxy-claude",
                                "costPerMTokIn": 15.0, "costPerMTokOut": 75.0}]
        pins = [{"pinned_model": "claude-opus-4-5"}]
        _, ok, _ = Harness(ROOM_LEDGER, roster, [], SHARE_LOW, pins_rows=pins).run(TUE_0730)
        self.assertFalse(ok)

    def test_unusable_roster_abstains_pin_leg(self):
        # No usable models: the pin leg abstains, so explicit room cannot be
        # established -> fail closed with the no-evidence message, not a crash.
        _, ok, msg = Harness(ROOM_LEDGER, [], [], SHARE_LOW,
                             pins_rows=[{"pinned_model": "glm-5.3"}]).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("FAIL: pinned zai numerator", msg)
        self.assertNotIn("peak allowance", msg)


class ServiceableIsNotRoomTest(unittest.TestCase):
    def test_unserviceable_verdict_alone_never_passes(self):
        # Retune-spec: serviceable alone is NOT laneHasRoom. A hard-down verdict
        # with room everywhere else must FAIL (page a human), not silently pass.
        verdict = {"state": "exhausted", "serviceable": False, "reason": "all-accounts-unserviceable"}
        ledger = ledger_with_obs(weekly_five_room(), verdict=verdict)
        _, ok, msg = Harness(ledger, ZAI_ROSTER, [], SHARE_LOW).run(TUE_0730)
        self.assertFalse(ok, "serviceable must not evidence denial, got: %s" % msg)

    def test_behind_lane_is_info_not_failure(self):
        extra = {"cliproxy-claude": {"laneId": "cliproxy-claude", "verdict": dict(BEHIND_VERDICT),
                                     "observation": {}, "fetchedAt": "x", "error": None}}
        mix = [("claude-x", 35)]
        _, ok, msg = Harness(ledger_with_obs(weekly_five_room(), extra=extra),
                             ZAI_ROSTER, mix, SHARE_LOW).run(SUN_0800)
        self.assertFalse(ok, msg)
        self.assertIn("numerator 0/35", msg)
        self.assertIn("pace=behind", msg)
        self.assertNotIn("but 0/35 runs in 60m", msg.split("INFO:")[0])


class MalformedLedgerTest(unittest.TestCase):
    def run_zero_malformed(self, zai_entry, share=None):
        ledger = {"cliproxy-zai": zai_entry}
        return Harness(ledger, ZAI_ROSTER, [], SHARE_LOW if share is None else share).run(TUE_0730)

    def test_truthy_non_dict_entries_crash_nothing(self):
        # TOG-13279 item 1: ledger schema drift must degrade to "no evidence",
        # never raise past the decision section skipping emit.
        for bad in ["oops", ["verdict"], 42, True]:
            with self.subTest(entry=repr(bad)):
                _, ok, msg = self.run_zero_malformed(bad)
                self.assertFalse(ok, msg)
                self.assertIn("no positive denial evidence", msg)

    def test_non_dict_verdict_and_observation(self):
        entry = {"laneId": "cliproxy-zai", "verdict": "behind", "observation": ["x"]}
        _, ok, msg = self.run_zero_malformed(entry)
        self.assertFalse(ok, msg)

    def test_non_dict_models_and_pins_rows(self):
        ledger = {"cliproxy-zai": "oops"}
        _, ok, msg = Harness(ledger, {"not": "a-list"}, [], SHARE_LOW, pins_rows="nope").run(TUE_0730)
        self.assertFalse(ok, msg)

    def test_malformed_behind_entries_stay_info_safe(self):
        ledger = {"cliproxy-zai": "oops",
                  "cliproxy-claude": {"verdict": "behind"},
                  "cliproxy-kimi": {"verdict": {"state": "behind"}}}
        mix = [("glm-5.3", 1), ("kimi-k2", 4)]
        _, ok, msg = Harness(ledger, ZAI_ROSTER, mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("cliproxy-kimi pace=behind (4/5 runs in 60m)", msg)
        self.assertNotIn("cliproxy-claude pace=behind", msg)


class FailClosedTest(unittest.TestCase):
    def test_missing_inputs_fail(self):
        for ledger, mix, share, pins in [
            (None, [], SHARE_LOW, []),
            ({}, [], SHARE_LOW, []),
            ([], [], SHARE_LOW, []),
            (NO_OBS_LEDGER, None, SHARE_LOW, []),
            (NO_OBS_LEDGER, [], None, []),
            (NO_OBS_LEDGER, [], [], []),
            (NO_OBS_LEDGER, [], [(1,)], []),
            (NO_OBS_LEDGER, [], SHARE_LOW, None),
        ]:
            with self.subTest(ledger=ledger, mix=mix, share=share, pins=pins):
                _, ok, msg = Harness(ledger, ZAI_ROSTER, mix, share, pins_rows=pins).run(TUE_0730)
                self.assertFalse(ok, msg)
                self.assertTrue(msg.startswith("FAIL: detector data"),
                                "fail-closed message expected, got: %s" % msg)

    def test_qj_error_fails(self):
        _, ok, msg = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], SHARE_LOW, error_on={"qj"}).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("missing/stale", msg)

    def test_query_error_fails(self):
        _, ok, msg = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], SHARE_LOW, error_on={"q"}).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("missing/stale", msg)


class PacingConfigTest(unittest.TestCase):
    def test_stored_pacing_names_honored(self):
        pacing = {"fiveHourWindowName": "custom-5h", "zai": {"laneId": "cliproxy-zai",
                                                             "weeklyWindowName": "custom-w",
                                                             "weeklyDefaultMargin": 0.15}}
        ledger = ledger_with_obs([obs_window("custom-w", 0.90), obs_window("custom-5h", 0.10)])
        _, ok, msg = Harness(ledger, ZAI_ROSTER, [], SHARE_LOW, pacing=pacing).run(TUE_0730)
        self.assertTrue(ok, msg)
        self.assertIn("weekly pace gate closed", msg)

    def test_absent_pacing_section_uses_schema_defaults(self):
        _, ok, _ = Harness(WEEKLY_DENIED_LEDGER, ZAI_ROSTER, [], SHARE_LOW, pacing=None).run(TUE_0730)
        self.assertTrue(ok)

    def test_wrong_typed_pacing_values_abstain(self):
        pacing = {"fiveHourWindowName": 5, "laneCapPerAccount": ["x"],
                  "zai": {"laneId": "cliproxy-zai", "weeklyWindowName": "weekly",
                          "weeklyDefaultMargin": "generous"}}
        # Weekly margin unusable -> weekly leg skipped; 5h name unusable -> 5h
        # leg skipped; cap unusable -> pin leg skipped; no legs -> no room, no
        # denial; share low -> FAIL with no-evidence message.
        _, ok, msg = Harness(ROOM_LEDGER, ZAI_ROSTER, [], SHARE_LOW, pacing=pacing).run(TUE_0730)
        self.assertFalse(ok, msg)
        self.assertIn("no positive denial evidence", msg)


class EmitIntegrationTest(unittest.TestCase):
    def test_wrapper_forwards_and_logs_on_both_paths(self):
        calls = []

        def before(name, ok, msg):
            calls.append((name, ok, msg))
            return "pushed-%s" % ok

        wrapper = load_emit_wrapper(before)
        for ok in (True, False):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                result = wrapper.emit("platform_router-mix", ok, "hello info")
            self.assertEqual(calls[-1], ("platform_router-mix", ok, "hello info"))
            self.assertEqual(result, "pushed-%s" % ok)
            self.assertIn("hello info", buf.getvalue())
            self.assertIn("ok=%s" % ok, buf.getvalue())

    def test_wrapper_shares_signature_with_host_emit(self):
        import inspect

        def before(name, ok, msg):
            return None

        wrapper = load_emit_wrapper(before)
        self.assertEqual(list(inspect.signature(wrapper.emit).parameters), ["name", "ok", "msg"])


class InfoRetentionTest(unittest.TestCase):
    def test_info_on_numerator_success(self):
        extra = {"cliproxy-claude": {"laneId": "cliproxy-claude", "verdict": dict(BEHIND_VERDICT),
                                     "observation": {}, "fetchedAt": "x", "error": None}}
        mix = [("glm-5.3", 2), ("claude-x", 10)]
        _, ok, msg = Harness(ledger_with_obs(weekly_five_room(), verdict=dict(BEHIND_VERDICT), extra=extra),
                             ZAI_ROSTER, mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertIn("cliproxy-zai pace=behind (2/12 runs in 60m)", msg)
        self.assertIn("cliproxy-claude pace=behind (10/12 runs in 60m)", msg)

    def test_info_on_peak_allowance_success(self):
        extra = {"cliproxy-claude": {"laneId": "cliproxy-claude", "verdict": dict(BEHIND_VERDICT),
                                     "observation": {}, "fetchedAt": "x", "error": None}}
        _, ok, msg = Harness(ledger_with_obs(weekly_five_room(), extra=extra),
                             ZAI_ROSTER, [("claude-x", 10)], SHARE_LOW).run(TUE_0730)
        # Weekly open, 5h low, no pins -> room -> this FAILs; info must survive failure too
        self.assertFalse(ok, msg)
        self.assertIn("cliproxy-claude pace=behind (10/10 runs in 60m)", msg)
        ledger = ledger_with_obs(weekly_closed_five_low(), extra=extra)
        _, ok, msg = Harness(ledger, ZAI_ROSTER, [("claude-x", 10)], SHARE_LOW).run(TUE_0730)
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
        _, ok, msg = Harness(NO_OBS_LEDGER, models, mix, SHARE_LOW).run(SUN_0800)
        self.assertTrue(ok, msg)
        self.assertNotIn("fallbackOnly", msg)

    def test_emit_contract(self):
        h = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [("glm-5.3", 1)], SHARE_LOW)
        name, ok, msg = h.run(SUN_0800)
        self.assertEqual(name, "platform_router-mix")
        self.assertTrue(ok)
        self.assertTrue(isinstance(msg, str) and len(msg) > 0)
        self.assertNotIn("file card", msg)
        h = Harness(NO_OBS_LEDGER, ZAI_ROSTER, [], SHARE_LOW)
        _, ok, msg = h.run(SUN_0800)
        self.assertFalse(ok)
        self.assertIn("file card", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
