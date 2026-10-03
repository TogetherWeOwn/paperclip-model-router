LANE_OF = [("devin/", "cliproxy-devin"), ("claude-", "cliproxy-claude"), ("gpt-", "cliproxy-codex"), ("codex", "cliproxy-codex"),
           ("glm-", "cliproxy-zai"), ("muse-", "cliproxy-meta"), ("grok-", "cliproxy-xai"), ("kimi-", "cliproxy-kimi")]

def router_mix():
    PID = "191a4e31-e618-4e76-921a-7511bcc1c12f"
    ledger = qj(f"select value_json::text from plugin_state where plugin_id='{PID}' and state_key='laneLedger' order by updated_at desc limit 1")
    models = qj(f"select config_json->'models' from plugin_config where plugin_id='{PID}'")
    fb = {m.get("model") or m.get("id") for m in models if isinstance(m, dict) and m.get("fallbackOnly")}
    mix = {r[0]: int(r[1]) for r in q("""select usage_json->>'model', count(*) from heartbeat_runs
      where created_at > now()-interval '60 minutes' and usage_json->>'model' is not null group by 1""")}
    total = sum(mix.values())
    per_lane = {}
    for m, n in mix.items():
        lane = next((l for p, l in LANE_OF if m.startswith(p)), "other"); per_lane[lane] = per_lane.get(lane, 0) + n
    bad = []
    if total >= 30:
        for lane, v in ledger.items():
            vd = (v or {}).get("verdict") or {}
            if vd.get("state") == "behind" and vd.get("serviceable") and per_lane.get(lane, 0) == 0:
                bad.append(f"{lane} pace=behind but 0/{total} runs in 60m")
    fbn = sum(n for m, n in mix.items() if m in fb)
    if total >= 20 and fbn / total > 0.5:
        bad.append(f"fallbackOnly models {fbn}/{total} runs")
    emit("platform_router-mix", not bad, "; ".join(bad) + " -> no allowlisted fix: file card for the Automation Engineer (router) with advise rejections")
