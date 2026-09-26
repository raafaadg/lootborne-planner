// Diagnostic spike (read-only): dumps ConsumableCatalog.All and watches the modifiers the game
// builds from the potions that are actually active. Reads memory only; calls nothing.
'use strict';

const ga = Process.getModuleByName('GameAssembly.dll');
const nf = (name, ret, args) => new NativeFunction(ga.getExportByName(name), ret, args);
const il2cpp = {
  domainGet: nf('il2cpp_domain_get', 'pointer', []),
  assemblyOpen: nf('il2cpp_domain_assembly_open', 'pointer', ['pointer', 'pointer']),
  assemblyImage: nf('il2cpp_assembly_get_image', 'pointer', ['pointer']),
  classFromName: nf('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']),
  methodFromName: nf('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']),
  fieldFromName: nf('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']),
  fieldOffset: nf('il2cpp_field_get_offset', 'int', ['pointer']),
  fieldStaticGet: nf('il2cpp_field_static_get_value', 'void', ['pointer', 'pointer']),
};
const cstr = (s) => Memory.allocUtf8String(s);
const IMAGE = il2cpp.assemblyImage(il2cpp.assemblyOpen(il2cpp.domainGet(), cstr('Assembly-CSharp')));

function klass(ns, name) {
  const k = il2cpp.classFromName(IMAGE, cstr(ns), cstr(name));
  if (k.isNull()) throw new Error(`class ${ns}.${name} not found`);
  return k;
}
function offsets(ns, name, fields) {
  const k = klass(ns, name);
  const out = {};
  for (const f of fields) {
    const info = il2cpp.fieldFromName(k, cstr(f));
    out[f] = info.isNull() ? -1 : il2cpp.fieldOffset(info);
  }
  return out;
}
function str(p) {
  if (p.isNull()) return null;
  const n = p.add(0x10).readS32();
  return n >= 0 && n < 4096 ? p.add(0x14).readUtf16String(n) : null;
}

/** A static List<T>: walks it and maps every element. */
function staticList(ns, cls, field, map) {
  const info = il2cpp.fieldFromName(klass(ns, cls), cstr(field));
  if (info.isNull()) return null;
  const out = Memory.alloc(Process.pointerSize);
  il2cpp.fieldStaticGet(info, out);
  const list = out.readPointer();
  if (list.isNull()) return null;
  const items = list.add(0x10).readPointer(); // List<T>: _items @0x10, _size @0x18
  const size = list.add(0x18).readS32();
  if (items.isNull() || size < 0 || size > 512) return null;
  const rows = [];
  for (let i = 0; i < size; i++) {
    const p = items.add(0x20 + i * 8).readPointer();
    if (!p.isNull()) rows.push(map(p));
  }
  return rows;
}

try {
  const e = offsets('AutoBattle.Data', 'ConsumableData', ['id', 'consumableName', 'category', 'effect', 'durationSec']);
  const rows = staticList('AutoBattle.Data', 'ConsumableCatalog', 'All', (p) => ({
    id: p.add(e.id).readS32(),
    name: str(p.add(e.consumableName).readPointer()),
    category: p.add(e.category).readS32(),
    effect: str(p.add(e.effect).readPointer()),
    durationSec: p.add(e.durationSec).readS32(),
  }));
  send({ ev: 'consumable_catalog', count: rows ? rows.length : 0, rows });
} catch (err) {
  send({ ev: 'consumable_catalog_error', error: String(err) });
}

// ConsumableSystem.GetActiveModifiers(PlayerState) -> ConsumableModifiers: ground truth for
// whatever the player has running right now, to check the numbers decoded from the binary.
const MOD_FIELDS = [
  'atkPct', 'defPct', 'maxHpPct', 'critFlat', 'parryFlat', 'damageTakenMult', 'lifestealPct',
  'ignoreEnemyDefPct', 'endOfFightHealPct', 'enemyHpMult', 'noStamina', 'ignoreAllResist',
  'sunderPerHit', 'executeBelowHpBonus', 'immolationPctPerTurn', 'dropRateBonus', 'xpBonusPct',
  'xpFloorPctOfBase', 'higherRarityBonus', 'pityThresholdOverride',
];
const BOOLS = new Set(['noStamina', 'ignoreAllResist', 'higherRarityBonus']);
const INTS = new Set(['sunderPerHit', 'pityThresholdOverride']);
try {
  const L = offsets('AutoBattle.Core', 'ConsumableModifiers', MOD_FIELDS);
  const m = il2cpp.methodFromName(klass('AutoBattle.Core', 'ConsumableSystem'), cstr('GetActiveModifiers'), 1);
  let last = '';
  Interceptor.attach(m.readPointer(), {
    onLeave(r) {
      if (r.isNull()) return;
      const out = {};
      for (const f of MOD_FIELDS) {
        const o = L[f];
        if (o < 0) continue;
        const v = BOOLS.has(f) ? r.add(o).readU8() === 1 : INTS.has(f) ? r.add(o).readS32() : Math.round(r.add(o).readFloat() * 1e4) / 1e4;
        if (v) out[f] = v;
      }
      const key = JSON.stringify(out);
      if (key !== last) {
        last = key;
        send({ ev: 'active_modifiers', mods: out });
      }
    },
  });
  send({ ev: 'ready', hooks: ['ConsumableSystem.GetActiveModifiers'] });
} catch (err) {
  send({ ev: 'hook_error', error: String(err) });
}


// LocalizationManager.entries: the active language's key -> text map, walked straight out of the
// Dictionary so consumable names come back in the language the player actually sees.
function localization() {
  const objClass = nf('il2cpp_object_get_class', 'pointer', ['pointer']);
  const lm = klass('AutoBattle.Core', 'LocalizationManager');
  const inst = il2cpp.fieldFromName(lm, cstr('_instance'));
  if (inst.isNull()) return null;
  const buf = Memory.alloc(Process.pointerSize);
  il2cpp.fieldStaticGet(inst, buf);
  const manager = buf.readPointer();
  if (manager.isNull()) return null;
  const lang = str(manager.add(0x30).readPointer());
  const dict = manager.add(0x20).readPointer(); // entries
  if (dict.isNull()) return { lang, entries: null };
  const dictClass = objClass(dict);
  const off = (name) => {
    const f = il2cpp.fieldFromName(dictClass, cstr(name));
    return f.isNull() ? -1 : il2cpp.fieldOffset(f);
  };
  const entriesOff = off('_entries');
  const countOff = off('_count');
  if (entriesOff < 0 || countOff < 0) return { lang, entries: null };
  const arr = dict.add(entriesOff).readPointer();
  const count = dict.add(countOff).readS32();
  if (arr.isNull() || count <= 0 || count > 20000) return { lang, entries: null };
  const out = {};
  // Entry<string,string>: int hashCode, int next, string key, string value = 24 bytes
  for (let i = 0; i < count; i++) {
    const e = arr.add(0x20 + i * 24);
    const k = str(e.add(8).readPointer());
    if (k === null) continue;
    out[k] = str(e.add(16).readPointer());
  }
  return { lang, entries: out };
}

try {
  const loc = localization();
  const keys = loc && loc.entries ? Object.keys(loc.entries) : [];
  const wanted = {};
  for (const k of keys) if (/consumable/i.test(k)) wanted[k] = loc.entries[k];
  send({ ev: 'localization', lang: loc && loc.lang, total: keys.length, consumables: wanted });
} catch (err) {
  send({ ev: 'localization_error', error: String(err) });
}

rpc.exports = {
  dispose() {
    Interceptor.detachAll();
  },
};
