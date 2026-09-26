"""S1 - Save watcher spike.

Polls the Lootborne save (read-only), diffs consecutive snapshots and emits events.
Every distinct save version is copied to spikes/out/snapshots/ so it can become a test fixture.

Usage: python s1_save_watcher.py [minutes]
"""
import glob
import json
import os
import sys
import time
from datetime import datetime

DATA_DIR = os.path.expandvars(r"%USERPROFILE%\AppData\LocalLow\Turbolento Games\Lootborne")
OUT_DIR = os.path.join(os.path.dirname(__file__), "out")
SNAP_DIR = os.path.join(OUT_DIR, "snapshots")
EVENTS = os.path.join(OUT_DIR, "s1_events.jsonl")
POLL_S = 0.5
RARITY = {0: "Common", 1: "Rare", 2: "Epic", 3: "Legendary", 4: "Mythic"}

# Fields handled by a dedicated event; everything else is reported as a generic change.
HANDLED = {
    "xp", "level", "stamina", "currentHp", "totalBattleTime", "fightsInSectorPersistent",
    "killsWithoutDrop", "dmgTakenPctAccumInSector", "vigorLastExitUtcTicks", "inventory",
    "nextUid", "deathsInSectorPersistent", "currentSector", "sectorEnemy", "battleActive",
    "muratoBattlesSinceProgress", "muratoBattlesSinceAction", "sector0DropCount",
}


def find_save():
    paths = [p for p in glob.glob(os.path.join(DATA_DIR, "save_*_game.json"))]
    return max(paths, key=os.path.getmtime) if paths else None


def read_save(path, attempts=5):
    """The game rewrites the file in place; retry until the JSON parses."""
    for _ in range(attempts):
        try:
            with open(path, "rb") as f:
                raw = f.read()
            outer = json.loads(raw)
            return raw, outer, json.loads(outer["payload"])
        except (json.JSONDecodeError, KeyError, OSError):
            time.sleep(0.1)
    return None, None, None


def emit(kind, **data):
    rec = {"t": datetime.now().isoformat(timespec="milliseconds"), "event": kind, **data}
    line = json.dumps(rec, ensure_ascii=False)
    print(line, flush=True)
    with open(EVENTS, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def item_summary(it):
    return {
        "uid": it["uid"], "name": it["itemName"], "templateId": it["templateId"],
        "slot": it["slot"], "rarity": RARITY.get(it["rarity"], it["rarity"]),
        "grantSource": it.get("grantSource"), "hp": it["hp"], "atk": round(it["atk"], 2),
        "def": round(it["def"], 2), "crit": round(it["crit"], 2), "parry": round(it["parry"], 2),
        "effects": it.get("effects", []),
    }


def diff(a, b, dt_write):
    if b["fightsInSectorPersistent"] != a["fightsInSectorPersistent"] or b["xp"] != a["xp"] or b["level"] != a["level"]:
        emit("battle_end", since_last_write_s=dt_write,
             fights=b["fightsInSectorPersistent"] - a["fightsInSectorPersistent"],
             xp=[a["xp"], b["xp"]], level=b["level"], hp=[a["currentHp"], b["currentHp"]],
             stamina=[round(a["stamina"], 2), round(b["stamina"], 2)],
             battle_time=round(b["totalBattleTime"] - a["totalBattleTime"], 2),
             sector=b["currentSector"], enemy=b["sectorEnemy"], pity=b["killsWithoutDrop"],
             murato=[b["muratoBattlesSinceProgress"], b["muratoBattlesSinceAction"]])
    if b["level"] > a["level"]:
        emit("level_up", level=[a["level"], b["level"]], unspent=b.get("unspentStatPoints"))
    if b["deathsInSectorPersistent"] > a["deathsInSectorPersistent"]:
        emit("death", deaths=b["deathsInSectorPersistent"], sector=b["currentSector"], enemy=b["sectorEnemy"])
    if b["currentSector"] != a["currentSector"]:
        emit("sector_change", sector=[a["currentSector"], b["currentSector"]])
    if b["battleActive"] != a["battleActive"]:
        emit("battle_active", value=b["battleActive"], hp=b["currentHp"], stamina=round(b["stamina"], 2))
    ua = {i["uid"]: i for i in a["inventory"]}
    ub = {i["uid"]: i for i in b["inventory"]}
    for uid in ub.keys() - ua.keys():
        emit("item_drop", item=item_summary(ub[uid]), inventory=len(ub))
    for uid in ua.keys() - ub.keys():
        emit("item_removed", item=item_summary(ua[uid]), inventory=len(ub))
    for uid in ua.keys() & ub.keys():
        if ua[uid] != ub[uid]:
            changed = {k: [ua[uid].get(k), ub[uid].get(k)] for k in ub[uid] if ua[uid].get(k) != ub[uid].get(k)}
            emit("item_changed", uid=uid, name=ub[uid]["itemName"], changed=changed)
    other = {k: [a.get(k), b.get(k)] for k in b if k not in HANDLED and a.get(k) != b.get(k)}
    if other:
        emit("field_change", fields=other)


def main():
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 15
    os.makedirs(SNAP_DIR, exist_ok=True)
    path = find_save()
    if not path:
        sys.exit("save not found")
    replays = set(glob.glob(os.path.join(DATA_DIR, "Replays", "*.json")))
    last_mtime, prev, last_write, last_alert = None, None, None, 0.0
    end = time.time() + minutes * 60
    emit("watch_start", save=path, minutes=minutes, replays=len(replays))
    while time.time() < end:
        try:
            mtime = os.path.getmtime(path)
        except OSError:  # the game rotates .bak and replaces the file; it is briefly absent
            mtime = last_mtime
        if mtime != last_mtime:
            raw, outer, payload = read_save(path)
            if payload is None:
                emit("read_retry_exhausted")
            if payload is not None:
                last_mtime = mtime
                now = time.time()
                with open(os.path.join(SNAP_DIR, f"save_{int(mtime * 1000)}.json"), "wb") as snap:
                    snap.write(raw)
                if prev is None:
                    emit("snapshot", level=payload["level"], xp=payload["xp"], hp=payload["currentHp"],
                         stamina=round(payload["stamina"], 2), sector=payload["currentSector"],
                         enemy=payload["sectorEnemy"], inventory=len(payload["inventory"]),
                         battleActive=payload["battleActive"], sigVersion=outer.get("sigVersion"))
                else:
                    diff(prev, payload, round(now - last_write, 2))
                prev, last_write = payload, now
        for rp in set(glob.glob(os.path.join(DATA_DIR, "Replays", "*.json"))) - replays:
            replays.add(rp)
            time.sleep(0.3)
            try:
                with open(rp, encoding="utf-8") as f:
                    r = json.load(f)
                emit("pvp_result", file=os.path.basename(rp), won=r["playerWon"], friendly=r["isFriendly"],
                     opponent=r["opponent"]["name"], opp_level=r["opponent"]["level"], turns=len(r["turns"]))
            except (OSError, json.JSONDecodeError, KeyError) as e:
                emit("pvp_parse_error", file=os.path.basename(rp), error=str(e))
        if last_write and time.time() - last_write > 60 and time.time() - last_alert > 60:
            emit("no_write", seconds=round(time.time() - last_write), battleActive=prev["battleActive"])
            last_alert = time.time()
        time.sleep(POLL_S)
    emit("watch_end")


if __name__ == "__main__":
    main()
