"""Extracts the icons the game draws, and packs them into one sprite sheet per family.

Three sources:
  items        ItemData.icon is a PPtr to a Sprite in sharedassets0 (the fields are laid out in
               declaration order, so the same hand reader spikes/s5_catalog.py uses walks to it)
  perks        Resources/perkicons/<id>_<name>, listed in globalgamemanagers' ResourceManager
  consumables  Resources/consumableicons/<name>, same manifest

The art is 28x28 pixel art, so everything fits in a small sheet; the app positions it by index.

Usage: python spikes/s7_icons.py [game_data_dir]
"""

import json
import os
import re
import struct
import sys

import UnityPy
from PIL import Image

GAME = sys.argv[1] if len(sys.argv) > 1 else r"D:\SteamLibrary\steamapps\common\Lootborne\Lootborne_Data"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "game-data", "icons")


class Reader:
    def __init__(self, raw):
        self.b = raw
        self.o = 0

    def align(self):
        self.o = (self.o + 3) & ~3

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]
        self.o += 4
        return v

    def boolean(self):
        v = self.b[self.o] != 0
        self.o += 1
        self.align()
        return v

    def string(self):
        n = self.i32()
        s = self.b[self.o:self.o + n].decode("utf-8", "replace")
        self.o += n
        self.align()
        return s

    def pptr(self):
        self.i32()
        path_id = struct.unpack_from("<q", self.b, self.o)[0]
        self.o += 8
        return path_id

    def mono_header(self):
        self.pptr()
        self.boolean()
        self.pptr()
        return self.string()


def item_icon(raw):
    """ItemData up to `icon`: returns (id, name, sprite path id)."""
    r = Reader(raw)
    r.mono_header()
    item_id = r.i32()
    name = r.string()
    for _ in range(3):  # slot, rarity, category
        r.i32()
    r.i32()  # hp
    for _ in range(4):  # atk, def, crit, parry
        r.f32()
    r.boolean()  # isMelee
    r.boolean()  # isBossExclusive
    for _ in range(r.i32()):  # effects
        r.string()
    return item_id, name, r.pptr()


def sheet(images, path, cell=None):
    """Packs same-size icons into a square-ish grid and writes the PNG."""
    if not images:
        return None
    w = cell or max(im.width for im in images)
    h = cell or max(im.height for im in images)
    cols = min(24, len(images))
    rows = (len(images) + cols - 1) // cols
    canvas = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, im in enumerate(images):
        x = (i % cols) * w + (w - im.width) // 2
        y = (i // cols) * h + (h - im.height) // 2
        canvas.paste(im, (x, y), im if im.mode == "RGBA" else None)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    canvas.save(path, optimize=True)
    return {"cols": cols, "cell": [w, h], "count": len(images)}


def resource_sprites(prefix):
    """The Resources manifest: path -> Sprite, for everything under `prefix`."""
    env = UnityPy.load(os.path.join(GAME, "globalgamemanagers"))
    manager = next((o.read() for o in env.objects if o.type.name == "ResourceManager"), None)
    if manager is None:
        return {}
    out = {}
    for path, ptr in manager.m_Container:
        if not path.startswith(prefix):
            continue
        try:
            obj = ptr.read()
        except Exception:
            continue
        if getattr(obj, "image", None) is not None:
            out[path] = obj.image
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}

    # ---- items ---------------------------------------------------------------------------
    env = UnityPy.load(os.path.join(GAME, "sharedassets0.assets"))
    sprites = {o.path_id: o for o in env.objects if o.type.name == "Sprite"}
    items = []
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        try:
            if o.read(check_read=False).m_Script.read().m_ClassName != "ItemData":
                continue
            item_id, name, icon = item_icon(o.get_raw_data())
        except Exception:
            continue
        obj = sprites.get(icon)
        if obj is not None:
            items.append((item_id, name, obj.read().image))
    items.sort()
    meta = sheet([im for _, _, im in items], os.path.join(OUT, "items.png"))
    index["items"] = {**meta, "ids": [i for i, _, _ in items]}

    # ---- perks ---------------------------------------------------------------------------
    perks = []
    for path, img in resource_sprites("perkicons/").items():
        if path.endswith("_installed"):
            continue
        m = re.search(r"perkicons/(\d+)_", path)
        if m:
            perks.append((int(m.group(1)), img))
    perks = sorted({pid: img for pid, img in perks}.items())
    meta = sheet([img for _, img in perks], os.path.join(OUT, "perks.png"))
    if meta:
        index["perks"] = {**meta, "ids": [pid for pid, _ in perks]}

    # ---- consumables ---------------------------------------------------------------------
    catalog = json.load(open(os.path.join(ROOT, "game-data", "consumables.json"), encoding="utf-8"))
    # the files drop the possessive ("Seeker's Luck" -> seeker_luck) and one name is misspelled
    ALIAS = {"rampart": "rampant"}

    def slugify(name):
        base = re.sub(r"'s\b", "", name.lower())
        base = re.sub(r"[^a-z0-9]+", "_", base).strip("_")
        return ALIAS.get(base, base)

    slug = {slugify(c["name"]): c["id"] for c in catalog}
    found = {}
    for path, img in resource_sprites("consumableicons/").items():
        key = path.split("/")[-1]
        cid = slug.get(key)
        if cid is not None:
            found[cid] = img
    rows = sorted(found.items())
    meta = sheet([img for _, img in rows], os.path.join(OUT, "consumables.png"))
    if meta:
        index["consumables"] = {**meta, "ids": [cid for cid, _ in rows]}
        missing = [c["name"] for c in catalog if c["id"] not in found]
        if missing:
            print("poções sem ícone:", missing)

    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)

    for name, meta in index.items():
        size = os.path.getsize(os.path.join(OUT, f"{name}.png")) / 1024
        print(f"{name}: {meta['count']} ícones {meta['cell'][0]}x{meta['cell'][1]} em {meta['cols']} colunas, {size:.0f} KB")


if __name__ == "__main__":
    main()
