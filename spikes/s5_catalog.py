"""S5 - Item/sector catalog from the game's assets (read-only).

The IL2CPP build strips typetrees, so ItemData/SectorData ScriptableObjects are decoded by hand
using the serialized field order from the Cpp2IL dump (re/decomp/AutoBattle.Data/*.cs).
Writes game-data/items.json and game-data/sectors.json, then validates against the save.
"""
import glob
import json
import os
import struct

import UnityPy

GAME = r"D:\SteamLibrary\steamapps\common\Lootborne\Lootborne_Data\sharedassets0.assets"
OUT = os.path.join(os.path.dirname(__file__), "..", "game-data")
SAVE_GLOB = os.path.expandvars(r"%USERPROFILE%\AppData\LocalLow\Turbolento Games\Lootborne\save_*_game.json")
SLOTS = ["Testa", "Corpo", "Cintura", "Arma", "Anello", "Trinket"]
RARITY = ["Common", "Rare", "Epic", "Legendary", "Mythic", "Ascended"]
ELEMENT = ["Nessuna", "Arcane", "Flame", "Frost", "Holy", "Shadow"]


class Reader:
    def __init__(self, raw):
        self.b, self.o = raw, 0

    def align(self):
        self.o = (self.o + 3) & ~3

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]
        self.o += 4
        return round(v, 4)

    def boolean(self):  # C# bool fields carry the align flag
        v = self.b[self.o] == 1
        self.o += 1
        self.align()
        return v

    def string(self):
        n = self.i32()
        s = self.b[self.o:self.o + n].decode("utf-8")
        self.o += n
        self.align()
        return s

    def pptr(self):
        file_id = self.i32()
        path_id = struct.unpack_from("<q", self.b, self.o)[0]
        self.o += 8
        return file_id, path_id

    def mono_header(self):
        self.pptr()          # m_GameObject
        self.boolean()       # m_Enabled
        self.pptr()          # m_Script
        return self.string()  # m_Name


def parse_item(raw):
    r = Reader(raw)
    asset = r.mono_header()
    item = {"id": r.i32(), "name": r.string(), "slot": SLOTS[r.i32()], "rarity": RARITY[r.i32()],
            "element": ELEMENT[r.i32()], "hp": r.i32(), "atk": r.f32(), "def": r.f32(), "crit": r.f32(),
            "parry": r.f32(), "isMelee": r.boolean(), "isBossExclusive": r.boolean()}
    item["effects"] = [r.string() for _ in range(r.i32())]
    item["asset"] = asset
    return item


def parse_sector(raw):
    r = Reader(raw)
    r.mono_header()
    s = {"id": r.i32(), "name": r.string(), "totalEnemies": r.i32()}
    s["categories"] = [r.pptr()[1] for _ in range(r.i32())]
    s["resist"], s["weak"] = ELEMENT[r.i32()], ELEMENT[r.i32()]
    s["dropPct"] = {k: r.f32() for k in ("common", "rare", "epic", "legendary", "mythic")}
    s["clearRewardRarity"], s["levelUpRarityCap"] = RARITY[r.i32()], RARITY[r.i32()]
    return s


def main():
    env = UnityPy.load(GAME)
    items, sectors, errors = [], [], 0
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        cls = o.read(check_read=False).m_Script.read().m_ClassName
        try:
            if cls == "ItemData":
                items.append(parse_item(o.get_raw_data()))
            elif cls == "SectorData":
                sectors.append(parse_sector(o.get_raw_data()))
        except (struct.error, IndexError, UnicodeDecodeError):
            errors += 1
    items.sort(key=lambda i: i["id"])
    sectors.sort(key=lambda s: s["id"])
    os.makedirs(OUT, exist_ok=True)
    for name, data in (("items.json", items), ("sectors.json", sectors)):
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"items={len(items)} sectors={len(sectors)} parse_errors={errors}")
    by_rarity = {}
    for i in items:
        by_rarity[i["rarity"]] = by_rarity.get(i["rarity"], 0) + 1
    print("by rarity", by_rarity)
    for s in sectors:
        print(f"  sector {s['id']} {s['name']}: enemies={s['totalEnemies']} drop%={s['dropPct']} "
              f"resist={s['resist']} weak={s['weak']} clear={s['clearRewardRarity']}")

    # validate: every inventory templateId resolves, and name/stats match
    with open(max(glob.glob(SAVE_GLOB), key=os.path.getmtime), encoding="utf-8") as f:
        inv = json.loads(json.load(f)["payload"])["inventory"]
    cat = {i["id"]: i for i in items}
    ok = mismatch = missing = 0
    for it in inv:
        c = cat.get(it["templateId"])
        if not c:
            missing += 1
            print("  missing template", it["templateId"], it["itemName"])
        elif c["name"] == it["itemName"] and c["hp"] == it["hp"] and abs(c["atk"] - it["atk"]) < 0.01:
            ok += 1
        else:
            mismatch += 1
            print("  mismatch", it["templateId"], it["itemName"], (it["hp"], it["atk"]), "vs", c["name"], (c["hp"], c["atk"]))
    print(f"validation vs save inventory: ok={ok} mismatch={mismatch} missing={missing} (of {len(inv)})")
    print("sample:", json.dumps(next(i for i in items if i["effects"]), ensure_ascii=False))


if __name__ == "__main__":
    main()
