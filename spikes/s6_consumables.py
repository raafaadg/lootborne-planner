"""Extracts what every consumable does, from GameAssembly.dll.

ConsumableSystem.GetActiveModifiers is a jump table over the consumable id: each case adds (or
multiplies, or sets) one field of ConsumableModifiers with a constant. This walks the table and
decodes each case, so we get the exact numbers instead of trusting the effect text.

Usage: python spikes/s6_consumables.py [path\\to\\GameAssembly.dll]
"""

import json
import os
import struct
import sys

import pefile

IMAGE_BASE = 0x180000000
JUMP_TABLE_RVA = 0x17EA18  # `mov rax,[rsi+17EA18h+rcx*4]` in GetActiveModifiers
CASES = 28  # `cmp rax,27 / ja default` -> ids 1..28

# ConsumableModifiers field offsets (from the Cpp2IL dump)
FIELDS = {
    0x10: "atkPct",
    0x14: "defPct",
    0x18: "maxHpPct",
    0x1C: "critFlat",
    0x20: "parryFlat",
    0x24: "damageTakenMult",
    0x28: "lifestealPct",
    0x2C: "ignoreEnemyDefPct",
    0x30: "endOfFightHealPct",
    0x34: "enemyHpMult",
    0x38: "noStamina",
    0x39: "ignoreAllResist",
    0x3C: "sunderPerHit",
    0x40: "executeBelowHpBonus",
    0x44: "immolationPctPerTurn",
    0x48: "dropRateBonus",
    0x4C: "xpBonusPct",
    0x50: "xpFloorPctOfBase",
    0x54: "higherRarityBonus",
    0x58: "pityThresholdOverride",
}

INT_FIELDS = {"sunderPerHit", "pityThresholdOverride"}
BOOL_FIELDS = {"noStamina", "ignoreAllResist", "higherRarityBonus"}


def find_dll(argv):
    if len(argv) > 1:
        return argv[1]
    roots = [
        r"D:\SteamLibrary\steamapps\common",
        r"C:\Program Files (x86)\Steam\steamapps\common",
    ]
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            if "GameAssembly.dll" in files and "ootborne" in dirpath:
                return os.path.join(dirpath, "GameAssembly.dll")
    raise SystemExit("GameAssembly.dll not found; pass the path")


class Image:
    def __init__(self, path):
        self.pe = pefile.PE(path, fast_load=True)

    def read(self, va, n):
        return self.pe.get_data(va - IMAGE_BASE, n)

    def f32(self, va):
        return round(struct.unpack("<f", self.read(va, 4))[0], 6)


def decode_case(img, va, limit=64):
    """One switch case: the (field, op, value) triples it applies before jumping to the loop."""
    out = []
    pos = va
    for _ in range(limit):
        b = img.read(pos, 16)
        # test rdi,rdi + je  -> the null guard the compiler emits before each case body
        if b[0:3] == b"\x48\x85\xff":
            pos += 3
            continue
        if b[0] == 0x74:  # je short
            pos += 2
            continue
        if b[0:2] == b"\x0f\x84":  # je near
            pos += 6
            continue
        # movss xmm0,[rdi+disp8]
        if b[0:4] == b"\xf3\x0f\x10\x47":
            field = b[4]
            pos += 5
            b = img.read(pos, 16)
            op = None
            if b[0:4] == b"\xf3\x0f\x58\x05":
                op = "+"
            elif b[0:4] == b"\xf3\x0f\x59\x05":
                op = "*"
            if op:
                rel = struct.unpack("<i", b[4:8])[0]
                value = img.f32(pos + 8 + rel)
                out.append((FIELDS.get(field, hex(field)), op, value))
                pos += 8
            continue
        # movss xmm0,[rip+rel32] then movss [rdi+disp8],xmm0  -> plain assignment
        if b[0:4] == b"\xf3\x0f\x10\x05":
            rel = struct.unpack("<i", b[4:8])[0]
            value = img.f32(pos + 8 + rel)
            nxt = img.read(pos + 8, 5)
            if nxt[0:4] == b"\xf3\x0f\x11\x47":
                out.append((FIELDS.get(nxt[4], hex(nxt[4])), "=", value))
                pos += 13
                continue
            pos += 8
            continue
        # movss [rdi+disp8],xmm0 -> the store of a pair we already recorded
        if b[0:4] == b"\xf3\x0f\x11\x47":
            pos += 5
            continue
        # mov byte ptr [rdi+disp8], imm8
        if b[0] == 0xC6 and b[1] == 0x47:
            out.append((FIELDS.get(b[2], hex(b[2])), "=", bool(b[3])))
            pos += 4
            continue
        # mov dword ptr [rdi+disp8], imm32 - a float field is stored as its raw bits
        if b[0] == 0xC7 and b[1] == 0x47:
            name = FIELDS.get(b[2], hex(b[2]))
            raw = b[3:7]
            value = struct.unpack("<i", raw)[0] if name in INT_FIELDS else round(struct.unpack("<f", raw)[0], 6)
            out.append((name, "=", value))
            pos += 7
            continue
        # add dword ptr [rdi+disp8], imm8  (integer field)
        if b[0] == 0x83 and b[1] == 0x47:
            out.append((FIELDS.get(b[2], hex(b[2])), "+", struct.unpack("<b", b[3:4])[0]))
            pos += 4
            continue
        # jmp -> end of the case
        if b[0] in (0xE9, 0xEB):
            break
        # anything else: stop rather than guess
        out.append(("?", "?", b[:6].hex()))
        break
    return out


def main():
    img = Image(find_dll(sys.argv))
    table = struct.unpack(f"<{CASES}I", img.read(IMAGE_BASE + JUMP_TABLE_RVA, CASES * 4))
    out = {}
    default_target = max(set(table), key=list(table).count)
    for i, entry in enumerate(table):
        cid = i + 1
        if entry == default_target and list(table).count(entry) > 2:
            print(f"id {cid:2d}  (sem efeito contínuo: instantâneo ou de uso único)")
            out[cid] = {}
            continue
        ops = decode_case(img, IMAGE_BASE + entry)
        mods = {}
        for field, op, value in ops:
            if op == "+":
                mods[field] = round(mods.get(field, 0) + value, 6)
            elif op == "*":
                mods[field] = round(mods.get(field, 1) * value, 6)
            else:
                mods[field] = value
        out[cid] = mods
        print(f"id {cid:2d}  {mods}")
    path = os.path.join(os.path.dirname(__file__), "out", "consumable_mods.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    print("\n->", path)


if __name__ == "__main__":
    main()
