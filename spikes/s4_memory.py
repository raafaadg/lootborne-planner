"""S4 - External, read-only memory reader (PROCESS_VM_READ only; never writes).

Finds IL2CPP classes by name (Il2CppClass.name -> metadata string), their live instances
(object header == klass pointer), then reads fields at the offsets from the Cpp2IL dump and
compares PlayerState against the save file.

Usage: python s4_memory.py [watch_seconds]
"""
import ctypes
import glob
import json
import os
import struct
import sys
import time
from ctypes import wintypes

from gamewin import game_pid

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
PROCESS_VM_READ, PROCESS_QUERY_INFORMATION = 0x0010, 0x0400
MEM_COMMIT, MEM_PRIVATE, MEM_MAPPED, MEM_IMAGE = 0x1000, 0x20000, 0x40000, 0x1000000
READABLE = {0x02, 0x04, 0x08, 0x20, 0x40, 0x80}  # RO, RW, WC, XR, XRW, XWC
SAVE_GLOB = os.path.expandvars(r"%USERPROFILE%\AppData\LocalLow\Turbolento Games\Lootborne\save_*_game.json")

# Offsets from re/decomp (Cpp2IL attributeinjector) - build c4889dfe (2026-09-21)
PLAYER = {"level": (0x1C, "i"), "xp": (0x20, "i"), "stamina": (0x24, "f"), "currentSector": (0x28, "i"),
          "sectorEnemy": (0x2C, "i"), "currentHp": (0x38, "i"), "battleActive": (0xA0, "?"),
          "killsWithoutDrop": (0xB4, "i"), "unspentStatPoints": (0xE4, "i"), "pvpCurrency": (0x114, "i"),
          "deathsInSectorPersistent": (0x1F0, "i"), "fightsInSectorPersistent": (0x1F4, "i")}
GAMEMANAGER = {"playerState": 0x38, "currentScreen": 0x40}
COMBAT = {"isInCombat": (0x38, "?"), "currentCombatEnemy": 0x40, "enemyHp": (0x68, "i"), "enemyMaxHp": (0x6C, "i")}
ENEMY = {"name": 0x10, "color": (0x28, "i"), "hp": (0x2C, "i"), "maxHp": (0x30, "i"), "atk": (0x34, "f"),
         "def": (0x38, "f"), "level": (0x44, "i"), "isPvP": (0x48, "?"), "xpWin": (0x58, "i"), "dropChance": (0x60, "f")}
AUTOFIGHT = {"isOn": (0x28, "?"), "armed": (0x29, "?")}
KLASS_NAME, KLASS_NS = 0x10, 0x18


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", wintypes.DWORD), ("PartitionId", wintypes.WORD),
                ("RegionSize", ctypes.c_size_t), ("State", wintypes.DWORD), ("Protect", wintypes.DWORD),
                ("Type", wintypes.DWORD)]


class Proc:
    def __init__(self, pid):
        self.h = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not self.h:
            raise OSError(ctypes.get_last_error())

    def read(self, addr, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t()
        if not k32.ReadProcessMemory(self.h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got)):
            return None
        return buf.raw[:got.value]

    def u64(self, addr):
        b = self.read(addr, 8)
        return struct.unpack("<Q", b)[0] if b else 0

    def val(self, addr, fmt):
        size = struct.calcsize("<" + fmt)
        b = self.read(addr, size)
        return struct.unpack("<" + fmt, b)[0] if b else None

    def cstr(self, addr, n=128):
        b = self.read(addr, n) or b""
        return b.split(b"\0", 1)[0].decode("utf-8", "replace")

    def il2cpp_string(self, addr):
        if not addr:
            return None
        n = self.val(addr + 0x10, "i")
        if n is None or not 0 <= n < 512:
            return None
        return (self.read(addr + 0x14, n * 2) or b"").decode("utf-16-le", "replace")

    def regions(self, types):
        addr, mbi = 0, MBI()
        while k32.VirtualQueryEx(self.h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            base, size = mbi.BaseAddress or 0, mbi.RegionSize
            if mbi.State == MEM_COMMIT and mbi.Type in types and (mbi.Protect & 0xFF) in READABLE and not mbi.Protect & 0x100:
                yield base, size
            addr = base + size
            if addr >= 0x7FFFFFFFFFFF:
                break

    def scan(self, needle, types, align=1, limit=64):
        hits = []
        for base, size in self.regions(types):
            for off in range(0, size, 64 << 20):
                chunk = self.read(base + off, min(64 << 20, size - off))
                if not chunk:
                    continue
                i = chunk.find(needle)
                while i != -1:
                    if (base + off + i) % align == 0:
                        hits.append(base + off + i)
                        if len(hits) >= limit:
                            return hits
                    i = chunk.find(needle, i + 1)
        return hits


class Heap:
    """One-shot copy of the game's private committed memory (~0.7 GB, ~1.5 s) for fast searches."""

    def __init__(self, p):
        self.p = p
        self.chunks = [(b, d) for b, sz in p.regions({MEM_PRIVATE}) if (d := p.read(b, sz))]
        self.mapped = [(b, d) for b, sz in p.regions({MEM_MAPPED, MEM_IMAGE}) if (d := p.read(b, sz))]

    @staticmethod
    def _find(chunks, needle, align):
        for base, data in chunks:
            i = data.find(needle)
            while i != -1:
                if (base + i) % align == 0:
                    yield base + i
                i = data.find(needle, i + 1)

    def find(self, needle, align=8):
        return list(self._find(self.chunks, needle, align))

    def find_cstring(self, text):
        needle = b"\0" + text.encode() + b"\0"
        return [a + 1 for a in self._find(self.mapped + self.chunks, needle, 1)]


def klass_name(p, klass):
    return p.cstr(p.u64(klass + KLASS_NAME)), p.cstr(p.u64(klass + KLASS_NS))


def find_class(heap, name, namespace):
    """Il2CppClass whose name/namespaze char* point at these metadata strings."""
    for name_ptr in heap.find_cstring(name):
        for ref in heap.find(struct.pack("<Q", name_ptr)):
            klass = ref - KLASS_NAME
            if klass_name(heap.p, klass) == (name, namespace):
                return klass
    return None


def find_instances(heap, klass):
    """Candidate objects: 8-aligned words equal to the klass pointer (callers validate fields)."""
    return heap.find(struct.pack("<Q", klass))


def read_fields(p, obj, spec):
    return {k: p.val(obj + v[0], v[1]) for k, v in spec.items() if isinstance(v, tuple)}


def latest_save():
    path = max(glob.glob(SAVE_GLOB), key=os.path.getmtime)
    with open(path, encoding="utf-8") as f:
        return json.loads(json.load(f)["payload"]), os.path.getmtime(path)


def main():
    watch = float(sys.argv[1]) if len(sys.argv) > 1 else 0
    p = Proc(game_pid())
    t0 = time.perf_counter()
    heap = Heap(p)
    print(f"heap copy {sum(len(d) for _, d in heap.chunks) >> 20} MB in {time.perf_counter() - t0:.1f}s")
    classes = {}
    for name, ns in (("PlayerState", "AutoBattle.Core"), ("GameManager", "AutoBattle.Core"),
                     ("CombatManager", "AutoBattle.Combat"), ("AutoFightController", "AutoBattle.Core")):
        classes[name] = find_class(heap, name, ns)
        print(f"class {ns}.{name} -> {hex(classes[name]) if classes[name] else None}")
    t_cls = time.perf_counter() - t0

    gm = None
    for inst in find_instances(heap, classes["GameManager"]):
        ps = p.u64(inst + GAMEMANAGER["playerState"])
        if ps and p.u64(ps) == classes["PlayerState"]:
            gm = inst
            break
    cm = next((i for i in find_instances(heap, classes["CombatManager"]) if gm and p.u64(i + 0x28) == gm), None)
    af = next((i for i in find_instances(heap, classes["AutoFightController"])
               if p.val(i + 0x28, "B") in (0, 1) and p.val(i + 0x29, "B") in (0, 1)
               and klass_name(p, p.u64(p.u64(i + 0x30)))[0] == "List`1"), None)
    del heap
    print(f"GameManager={hex(gm) if gm else None} CombatManager={hex(cm) if cm else None} "
          f"AutoFight={hex(af) if af else None} (locate {time.perf_counter() - t0:.1f}s, classes {t_cls:.1f}s)")
    if not gm:
        sys.exit("GameManager instance not found")
    ps = p.u64(gm + GAMEMANAGER["playerState"])

    def snapshot():
        live = read_fields(p, ps, PLAYER)
        live["name"] = p.il2cpp_string(p.u64(ps + 0x10))
        live["screen"] = p.val(gm + GAMEMANAGER["currentScreen"], "i")
        if cm:
            live.update({f"combat.{k}": v for k, v in read_fields(p, cm, COMBAT).items()})
            en = p.u64(cm + COMBAT["currentCombatEnemy"])
            if en:
                live.update({f"enemy.{k}": v for k, v in read_fields(p, en, ENEMY).items()})
                live["enemy.name"] = p.il2cpp_string(p.u64(en + ENEMY["name"]))
        if af:
            live.update({f"autofight.{k}": v for k, v in read_fields(p, af, AUTOFIGHT).items()})
        return live

    live = snapshot()
    save, mtime = latest_save()
    print(f"\nsave age {time.time() - mtime:.1f}s")
    for k in PLAYER:
        mark = "==" if live[k] == save[k] or (isinstance(save[k], float) and abs(live[k] - save[k]) < 2) else "!="
        print(f"  {k:26} live={live[k]!r:>12} {mark} save={save[k]!r}")
    print("  extra (memory only):", {k: v for k, v in live.items() if k not in PLAYER})
    end = time.time() + watch
    while time.time() < end:
        time.sleep(1)
        s = snapshot()
        print(time.strftime("%H:%M:%S"), f"hp={s['currentHp']} enemy={s.get('enemy.name')} "
              f"{s.get('combat.enemyHp')}/{s.get('combat.enemyMaxHp')} inCombat={s.get('combat.isInCombat')} "
              f"screen={s['screen']} autofight={s.get('autofight.isOn')}/{s.get('autofight.armed')} xp={s['xp']}")


if __name__ == "__main__":
    main()
