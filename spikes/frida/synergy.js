// Diagnostic spike (read-only): watch StatsCalculator's two synergy passes and read PerkCatalog.All.
// Answers "where do the 357 PWR the estimate misses come from?". Observes only: no writes, no calls.
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
const send_ = (o) => send(o);

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
  return n >= 0 && n < 2048 ? p.add(0x14).readUtf16String(n) : null;
}
/** PlayerStats: {int hp; float atk, def, crit, parry} */
const stats = (p) => ({
  hp: p.readS32(),
  atk: Math.round(p.add(4).readFloat() * 1e4) / 1e4,
  def: Math.round(p.add(8).readFloat() * 1e4) / 1e4,
  crit: Math.round(p.add(12).readFloat() * 1e4) / 1e4,
  parry: Math.round(p.add(16).readFloat() * 1e4) / 1e4,
});
const delta = (a, b) => {
  const d = {};
  for (const k of ['hp', 'atk', 'def', 'crit', 'parry']) {
    const v = Math.round((b[k] - a[k]) * 1e4) / 1e4;
    if (v) d[k] = v;
  }
  return d;
};

// ---- PerkCatalog.All: the psWeight GetPowerScore(stats, state) adds -------------------------
try {
  const k = klass('AutoBattle.Data', 'PerkCatalog');
  const field = il2cpp.fieldFromName(k, cstr('All'));
  const buf = Memory.alloc(8);
  il2cpp.fieldStaticGet(field, buf);
  const list = buf.readPointer(); // List<PerkData>: _items @0x10, _size @0x18
  const items = list.add(0x10).readPointer();
  const size = list.add(0x18).readS32();
  const e = offsets('AutoBattle.Data', 'PerkData', ['id', 'perkName', 'tier', 'levelReq', 'cost', 'psWeight']);
  const perks = [];
  for (let i = 0; i < size && i < 128; i++) {
    const p = items.add(0x20 + i * 8).readPointer();
    if (p.isNull()) continue;
    perks.push({
      id: p.add(e.id).readS32(),
      name: str(p.add(e.perkName).readPointer()),
      tier: p.add(e.tier).readS32(),
      levelReq: p.add(e.levelReq).readS32(),
      cost: p.add(e.cost).readS32(),
      psWeight: p.add(e.psWeight).readS32(),
    });
  }
  send_({ ev: 'perk_catalog', count: perks.length, perks });
} catch (err) {
  send_({ ev: 'perk_catalog_error', error: String(err) });
}

// ---- the two synergy passes, one line per effect string ------------------------------------
const HOOKS = [
  // ApplySynergyBonuses(string effect, Dictionary<ElementCategory,int> counts, ref PlayerStats stats)
  ['ApplySynergyBonuses', 3, 2],
  // ApplyCrossSynergyBonuses(string effect, ElementCategory bearer, Dictionary counts,
  //   HashSet<string> names, bool dual, bool shield, int categoryCount, ref PlayerStats stats)
  ['ApplyCrossSynergyBonuses', 8, 7],
];
const sc = klass('AutoBattle.Core', 'StatsCalculator');
const ok = [];
for (const [name, argc, statsArg] of HOOKS) {
  const m = il2cpp.methodFromName(sc, cstr(name), argc);
  if (m.isNull()) {
    send_({ ev: 'hook_failed', name });
    continue;
  }
  Interceptor.attach(m.readPointer(), { // MethodInfo.methodPointer
    onEnter(a) {
      this.p = a[statsArg];
      this.effect = str(a[0]);
      this.before = stats(this.p);
      if (name === 'ApplyCrossSynergyBonuses') {
        this.bearer = a[1].toInt32();
        this.dual = (a[4].toUInt32() & 0xff) === 1;
        this.shield = (a[5].toUInt32() & 0xff) === 1;
        this.categoryCount = a[6].toInt32();
      }
    },
    onLeave() {
      const d = delta(this.before, stats(this.p));
      send_({
        ev: 'synergy',
        pass: name,
        effect: this.effect,
        delta: d,
        ...(this.bearer !== undefined ? { bearer: this.bearer, dual: this.dual, shield: this.shield, categoryCount: this.categoryCount } : {}),
      });
    },
  });
  ok.push(name);
}

// GetTotalStats: the running total, so the deltas can be checked against the final number
const gts = il2cpp.methodFromName(sc, cstr('GetTotalStats'), 3);
if (!gts.isNull()) {
  Interceptor.attach(gts.readPointer(), {
    onEnter(a) {
      this.ret = a[0];
      this.perks = (a[3].toUInt32() & 0xff) === 1;
    },
    onLeave() {
      send_({ ev: 'total', applyPerks: this.perks, stats: stats(this.ret) });
    },
  });
}

send_({ ev: 'ready', hooks: ok });
rpc.exports = { dispose() {
  Interceptor.detachAll();
} };
