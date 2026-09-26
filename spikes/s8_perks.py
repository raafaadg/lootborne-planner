"""Decodes PerkCombat.ApplyPerk from GameAssembly.dll: what each perk writes into PerkModifiers.

ApplyPerk is a 0x70-byte dispatcher over a jump table; the 30 case bodies sit in code no tool
attributes to a method. Each case is a handful of SSE loads/stores on PerkModifiers (rbx), sometimes
behind `test sil,sil` (isPvP) or a PerkEconomy.V(v1, v2) call. This walks the table and decodes just
those shapes, printing raw bytes for anything else.

Usage: python spikes/s8_perks.py [GameAssembly.dll]
"""
import re, struct, sys
import pefile

DLL = sys.argv[1] if len(sys.argv) > 1 else r"D:\SteamLibrary\steamapps\common\Lootborne\GameAssembly.dll"
pe = pefile.PE(DLL, fast_load=True)
B = pe.OPTIONAL_HEADER.ImageBase
TABLE_RVA, START, END, EXIT = 0x1B35BC, 0x1801B3070, 0x1801B3640, 0x1801B30ED
V_ADDR = 0x18018FD10  # PerkEconomy.V(v1, v2)

src = open('re/decomp/AutoBattle.Core/PerkModifiers.cs', encoding='utf-8').read()
FIELDS = {int(m.group(1), 16): m.group(2) for m in re.finditer(r'Offset = "0x([0-9A-F]+)"\)\]\s*\n\s*public \w+ (\w+);', src)}
code = pe.get_data(START - B, END - START)
at = lambda va: code[va - START:]
f32 = lambda raw: struct.unpack('<f', raw)[0]
rip = lambda va, ln, disp: va + ln + disp
fld = lambda off: FIELDS.get(off, f'+{off:#x}')
XMM = lambda r: f'xmm{r}'

def modrm(buf, va, pre_len):
    m = buf[0]; mod, reg, rm = m >> 6, (m >> 3) & 7, m & 7
    if mod == 0 and rm == 5:
        disp = int.from_bytes(buf[1:5], 'little', signed=True)
        target = rip(va, pre_len + 5, disp)
        return reg, f'[{f32(pe.get_data(target - B, 4)):.6g}]', 5
    if mod == 1 and rm == 3:  # [rbx+disp8]
        return reg, fld(buf[1]), 2
    if mod == 3:
        return reg, XMM(rm), 1
    return reg, f'?modrm {m:02x}', 1

SSE = {0x10: 'movss', 0x11: 'movss→', 0x58: 'addss', 0x59: 'mulss', 0x5C: 'subss', 0x5D: 'minss', 0x5F: 'maxss', 0x2A: 'cvtsi2ss'}

def decode(va, limit=40):
    out = []
    for _ in range(limit):
        b = at(va)
        if b[:1] == b'\xc6' and b[1] == 0x43:
            out.append(f'{fld(b[2])} = {b[3]}'); va += 4
        elif b[:1] == b'\xc7' and b[1] == 0x43:
            out.append(f'{fld(b[2])} = {f32(b[3:7]):.6g} (0x{int.from_bytes(b[3:7],"little"):08x})'); va += 7
        elif b[:2] == b'\xf3\x0f' and b[2] in SSE:
            reg, opnd, n = modrm(b[3:], va, 3)
            op = SSE[b[2]]
            out.append(f'{opnd} = {XMM(reg)}' if op == 'movss→' else f'{op} {XMM(reg)}, {opnd}'); va += 3 + n
        elif b[:3] == b'\x40\x84\xf6':
            out.append('test isPvP'); va += 3
        elif b[:1] in (b'\x74', b'\x75', b'\xeb'):
            tgt = va + 2 + int.from_bytes(b[1:2], 'little', signed=True)
            out.append({0x74: 'je', 0x75: 'jne', 0xeb: 'jmp'}[b[0]] + f' {tgt:#x}'); va += 2
            if b[0] == 0xeb: break
        elif b[:1] == b'\xe9':
            tgt = va + 5 + int.from_bytes(b[1:5], 'little', signed=True)
            out.append(f'jmp {tgt:#x}'); break
        elif b[:1] == b'\xe8':
            tgt = va + 5 + int.from_bytes(b[1:5], 'little', signed=True)
            out.append('call PerkEconomy.V' if tgt == V_ADDR else f'call {tgt:#x}'); va += 5
        elif b[:3] == b'\x0f\x28\xc6':
            out.append('xmm0 = xmm6'); va += 3
        elif b[:3] == b'\x0f\x28\xf0':
            out.append('xmm6 = xmm0'); va += 3
        elif b[:3] == b'\x0f\x57\xc0':
            out.append('xmm0 = 0'); va += 3
        elif b[:3] == b'\x45\x33\xc0':
            out.append('r8 = 0'); va += 3
        elif b[:3] == b'\x48\x8b\x0d':
            va += 7  # mov rcx,[rip+x]: class pointer for the init check
        elif b[:3] == b'\x83\xb9\xe4':
            va += 7  # cmp [rcx+0E4h],0: class initialised?
        elif b[:2] == b'\x83\x43':
            out.append(f'{fld(b[2])} += {int.from_bytes(b[3:4], "little", signed=True)}'); va += 4
        elif b[:2] in (b'\x0f\x85', b'\x0f\x84'):
            tgt = va + 6 + int.from_bytes(b[2:6], 'little', signed=True)
            out.append(('jne' if b[1] == 0x85 else 'je') + f' {tgt:#x}'); va += 6
        elif b[:2] == b'\x0f\x28':
            reg, opnd, n = modrm(b[2:], va, 2)
            out.append(f'{XMM(reg)} = {opnd}'); va += 2 + n
        elif b[:3] == b'\x48\x8b\xcb':
            out.append('rcx = m'); va += 3
        elif b[:3] == b'\xf3\x0f\x5e':
            reg, opnd, n = modrm(b[3:], va, 3)
            out.append(f'divss {XMM(reg)}, {opnd}'); va += 3 + n
        else:
            out.append(f'?? {b[:8].hex(" ")} @ {va:#x}'); break
    return out

if __name__ == '__main__':
    tbl = pe.get_data(TABLE_RVA, 30 * 4)
    for k in range(30):
        va = B + int.from_bytes(tbl[4 * k:4 * k + 4], 'little')
        body = ['(nada em PerkModifiers)'] if va == EXIT else decode(va)
        print(f'perk {k + 1:>2} @ {va:#x}: ' + ' ; '.join(body))
        # the other side of each conditional branch, one level deep
        for line in body:
            m = re.match(r'(je|jne) (0x[0-9a-f]+)', line)
            if m and int(m.group(2), 16) != EXIT:
                print(f'          {m.group(1)} -> ' + ' ; '.join(decode(int(m.group(2), 16))))
