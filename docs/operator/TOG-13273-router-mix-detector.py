# Exact deployment artifact for TOG-13273 (prep only, no deploy).
# Source: router_mix() in /opt/tog6886-remediate/detect/oncall-detect.py (rbx1),
# BEFORE captured in document `operator-detector-source-handoff-20261003-1115`
# on TOG-12270 (source SHA256 95213016affba26dbbe746a54536de4d023768dbc6e62e91e6aaf8419cf3276c).
# Target semantics: document `retune-spec` on TOG-12270 (CEO decision D2 on TOG-12259).
#
# Deploy (host operator under TOG-12270, with BEFORE copy + rollback):
#   1. Verify the host file contains the BEFORE router_mix() shown in the handoff
#      document (SHA above). If it differs, STOP and return this artifact.
#   2. Replace the region starting at the `LANE_OF = [` line through the final
#      `emit(...)` line of the old router_mix() body with this whole file's
#      TOG-13273 block below (BEGIN through END, markers included).
#   3. Confirm host emit() forwards the message text on success (BEFORE emit
#      dropped info text on success); if it does not, patch emit() to forward
#      it (operator-owned one-line change) before reload.
#   4. Confirm the live ledger's cliproxy-zai verdict field names match the
#      VERDICT_FIELD_* constants; if the deployed schema names them
#      differently, update only those three constant strings (no logic change),
#      re-checksum, and record the new checksum on TOG-12270.
# No secrets in this file. No router defaults/config edits.

# ===== TOG-13273 router_mix retune (BEGIN) =====
LANE_OF = [("devin/", "cliproxy-devin"), ("claude-", "cliproxy-claude"), ("gpt-", "cliproxy-codex"), ("codex", "cliproxy-codex"),
           ("glm-", "cliproxy-zai"), ("muse-", "cliproxy-meta"), ("grok-", "cliproxy-xai"), ("kimi-", "cliproxy-kimi")]

ZAI_MODEL = "glm-5.3"            # exact usageJson.model counted in the numerator (exact match only)
ZAI_LANE = "cliproxy-zai"        # lane for ZAI_MODEL per LANE_OF ("glm-" prefix)
ROUTER_PLUGIN_ID = "191a4e31-e618-4e76-921a-7511bcc1c12f"
LOOKBACK_MINUTES = 60            # numerator window (unchanged from BEFORE)
SHARE_LOOKBACK_HOURS = 5         # telemetry window for the 5h share cutoff
FIVE_HOUR_SHARE_CUTOFF = 0.5     # zai 5h share >= 0.5 evidences an exhausted pace budget (retune-spec)
PEAK_WEEKDAYS = (0, 1, 2, 3, 4)  # Mon-Fri (datetime.weekday())
PEAK_START_HOUR_UTC = 6          # 06:00 UTC inclusive
PEAK_END_HOUR_UTC = 10           # 10:00 UTC exclusive
# Deployed ledger field names for the resolved lane state (operator verifies
# these against the live laneLedger sample at deploy; see header step 4).
VERDICT_FIELD_ROOM = "laneHasRoom"      # resolved per-lane room flag when published (bool)
VERDICT_FIELD_PACE_GATE = "paceGate"    # weekly pace gate marker when published
VERDICT_FIELD_PEAK_CAP = "peakCapped"   # peak-cap marker when published (bool)
ACTION_SUFFIX = " -> no allowlisted fix: file card for the Automation Engineer (router) with advise rejections"


def _zai_peak_now(now_utc):
    """True inside the Mon-Fri 06:00-10:00Z peak allowance window."""
    return now_utc.weekday() in PEAK_WEEKDAYS and PEAK_START_HOUR_UTC <= now_utc.hour < PEAK_END_HOUR_UTC


def _classify_lane(model_name):
    """Map a usageJson.model value to its lane (LANE_OF order; unchanged from BEFORE)."""
    return next((lane for prefix, lane in LANE_OF if model_name.startswith(prefix)), "other")


def _zai_lane_denied(*, now_utc, zai_verdict, zai_5h, total_5h):
    """Decide whether laneHasRoom denies zai from deployed resolved state + telemetry.

    Positive-evidence only: unknown/absent markers mean "has room" so the
    check fails closed (pages a human) instead of silently passing. Serviceable
    alone is NOT consulted here -- it is not laneHasRoom.
    Returns (denied: bool, reasons: [str]).
    """
    reasons = []
    if isinstance(zai_verdict, dict):
        resolved = zai_verdict.get(VERDICT_FIELD_ROOM)
        if resolved is False:
            return True, ["deployed resolved laneHasRoom=false for %s" % ZAI_LANE]
        if resolved is True:
            return False, []
        pace_gate = zai_verdict.get(VERDICT_FIELD_PACE_GATE)
        if pace_gate is False or (isinstance(pace_gate, str) and pace_gate.strip().lower() in ("closed", "exhausted", "deny", "denied")):
            reasons.append("deployed weekly pace gate closed for %s" % ZAI_LANE)
        if _zai_peak_now(now_utc) and zai_verdict.get(VERDICT_FIELD_PEAK_CAP) is True:
            reasons.append("deployed peak cap reached (1/account) for %s" % ZAI_LANE)
    if total_5h > 0 and (zai_5h / total_5h) >= FIVE_HOUR_SHARE_CUTOFF:
        reasons.append("zai 5h share %d/%d >= %s (pace budget exhausted)" % (zai_5h, total_5h, FIVE_HOUR_SHARE_CUTOFF))
    return (len(reasons) > 0), reasons


def _behind_info_lines(ledger, per_lane, total):
    """pace=behind signals, kept as info on every outcome (success and failure)."""
    info = []
    for lane, entry in ledger.items():
        verdict = (entry or {}).get("verdict") or {}
        if verdict.get("state") == "behind":
            info.append("%s pace=behind (%d/%d runs in 60m)" % (lane, per_lane.get(lane, 0), total))
    return info


def router_mix(now_utc=None):
    """Pinned-only zai numerator + peak allowance (TOG-13273, retune-spec).

    Pass if heartbeat runs with usageJson.model exactly glm-5.3 in the trailing
    60m number > 0. Pass with 0 only inside Mon-Fri 06:00-10:00Z while
    laneHasRoom evidences a zai denial. Unpinned default traffic (muse/opus)
    never fails this check. Stale/missing inputs fail closed.
    """
    import datetime as _dt
    if now_utc is None:
        now_utc = _dt.datetime.now(_dt.timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=_dt.timezone.utc)

    try:
        ledger = qj("select value_json::text from plugin_state where plugin_id='%s' and state_key='laneLedger' order by updated_at desc limit 1" % ROUTER_PLUGIN_ID)
        models = qj("select config_json->'models' from plugin_config where plugin_id='%s'" % ROUTER_PLUGIN_ID)
        rows = q("""select usage_json->>'model', count(*) from heartbeat_runs
      where created_at > now()-interval '60 minutes' and usage_json->>'model' is not null group by 1""")
        share_rows = q("""select count(*) filter (where usage_json->>'model' = '%s'), count(*) from heartbeat_runs
      where created_at > now()-interval '%d hours'""" % (ZAI_MODEL, SHARE_LOOKBACK_HOURS))
        if not isinstance(ledger, dict) or not ledger:
            raise ValueError("lane ledger missing or empty")
        if rows is None:
            raise ValueError("60m heartbeat mix missing")
        if not share_rows or share_rows[0] is None or len(share_rows[0]) != 2:
            raise ValueError("5h zai share telemetry missing")
        mix = {r[0]: int(r[1]) for r in rows}
        zai_5h, total_5h = int(share_rows[0][0]), int(share_rows[0][1])
    except Exception as exc:
        emit("platform_router-mix", False, "FAIL: detector data missing/stale (%s)%s" % (exc, ACTION_SUFFIX))
        return

    total = sum(mix.values())
    numerator = mix.get(ZAI_MODEL, 0)  # exact match only: glm-5.3-flash and friends do NOT count
    per_lane = {}
    for model, count in mix.items():
        lane = _classify_lane(model)
        per_lane[lane] = per_lane.get(lane, 0) + count
    info = _behind_info_lines(ledger, per_lane, total)
    info_text = (" | INFO: " + "; ".join(info)) if info else ""

    if numerator > 0:
        emit("platform_router-mix", True,
             "OK: pinned zai numerator %d/%d heartbeat runs in 60m (model %s)%s" % (numerator, total, ZAI_MODEL, info_text))
        return

    zai_verdict = (ledger.get(ZAI_LANE) or {}).get("verdict") or {}
    if _zai_peak_now(now_utc):
        denied, reasons = _zai_lane_denied(now_utc=now_utc, zai_verdict=zai_verdict, zai_5h=zai_5h, total_5h=total_5h)
        if denied:
            emit("platform_router-mix", True,
                 "OK: pinned zai numerator 0/%d in 60m within peak allowance (Mon-Fri 06:00-10:00Z); lane denies zai: %s%s"
                 % (total, "; ".join(reasons), info_text))
            return
        emit("platform_router-mix", False,
             "FAIL: pinned zai numerator 0/%d in 60m in peak window but lane has room for zai%s%s" % (total, info_text, ACTION_SUFFIX))
        return
    emit("platform_router-mix", False,
         "FAIL: pinned zai numerator 0/%d in 60m outside peak allowance (Mon-Fri 06:00-10:00Z)%s%s" % (total, info_text, ACTION_SUFFIX))
# ===== TOG-13273 router_mix retune (END) =====
