// Lootborne Planner - read-only Frida agent.
//
// Classes, methods AND field offsets are resolved by name through the exported il2cpp_* API, so
// nothing here is tied to one build. The hooks only observe arguments/return values: the agent
// never writes game memory, never calls game methods and never changes behaviour.
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

const missingFields = [];
/** Field offsets by name (object header included, as FieldInfo.offset stores them). -1 = missing. */
function layout(ns, name, fields) {
  const k = klass(ns, name);
  const out = {};
  for (const f of fields) {
    const info = il2cpp.fieldFromName(k, cstr(f));
    out[f] = info.isNull() ? -1 : il2cpp.fieldOffset(info);
    if (out[f] < 0) missingFields.push(`${name}.${f}`);
  }
  return out;
}

const L = {
  enemy: layout('AutoBattle.Combat', 'EnemyState', ['name', 'color', 'hp', 'maxHp', 'atk', 'def', 'crit', 'parry', 'level', 'isPvP', 'isArenaBoss', 'xpWin', 'dropChance', 'resistElement', 'resistElement2', 'weakElement',
    'isFriendlyPvP', 'isBossPvp', 'bossPvpIndex', 'isBifidus']),
  perks: layout('AutoBattle.Core', 'PerkModifiers', ['defToAtkPct', 'atkPct', 'defPct', 'maxHpPct', 'damageDealtMult', 'damageTakenMult', 'disableCrit', 'bonusDamageFlatPerHit', 'critCap', 'critFlat', 'enemyMaxHpDamagePct', 'parryFloor', 'tenacityLifestealPct', 'disableHealing', 'disableEndOfFightRegen', 'lifestealFlat', 'flatHealPerHit', 'atkFlat', 'defPctPerParryPoint']),
  item: layout('AutoBattle.Data', 'ItemInstance', ['uid', 'templateId', 'itemName', 'slot', 'rarity', 'grantSource']),
  turn: layout('AutoBattle.Combat', 'CombatTurnResult', ['isPlayerAttacking', 'damage', 'isCrit', 'isParried',
    'attackerHpAfter', 'defenderHpAfter', 'healFromEffect', 'enemyHealFromEffect', 'counterAttackDamage',
    'enemyCounterAttackDamage', 'suddenDeathActive']),
  result: layout('AutoBattle.Combat', 'CombatResult', ['playerWon', 'xpGained', 'droppedItem', 'remainingPlayerHp', 'sectorCleared', 'isPvP', 'enemyName', 'rpDelta', 'leveledUp', 'newLevel', 'levelUpItem', 'sectorBonusItem']),
  player: layout('AutoBattle.Core', 'PlayerState', ['level', 'xp', 'stamina', 'currentHp', 'battleActive', 'equippedPerkIds', 'equippedUids']),
  game: layout('AutoBattle.Core', 'GameManager', ['currentScreen', 'playerState']),
  // What the arena knows about an opponent. The replay files carry none of this beyond name/level/
  // maxHp and the gear, so perks and the exact stats are only ever visible here, live.
  snapshot: layout('AutoBattle.Steam', 'PlayerSnapshot', ['playerName', 'level', 'powerScore', 'hp',
    'atk', 'def', 'crit', 'parry', 'equippedPerkIds', 'rankingPoints', 'mmr', 'totalPvPMatches']),
};

const i32 = (p, o) => (o < 0 ? null : p.add(o).readS32());
const f32 = (p, o) => (o < 0 ? null : p.add(o).readFloat());
const bool = (p, o) => (o < 0 ? null : p.add(o).readU8() === 1);
const ptrAt = (p, o) => (o < 0 ? NULL : p.add(o).readPointer());
function str(p) {
  if (p.isNull()) return null;
  const n = p.add(0x10).readS32(); // Il2CppString: length @0x10, UTF-16 @0x14
  return n >= 0 && n < 512 ? p.add(0x14).readUtf16String(n) : null;
}

function enemy(p) {
  if (p.isNull()) return null;
  const e = L.enemy;
  return {
    name: str(ptrAt(p, e.name)), color: i32(p, e.color), hp: i32(p, e.hp), maxHp: i32(p, e.maxHp),
    atk: f32(p, e.atk), def: f32(p, e.def), crit: f32(p, e.crit), parry: f32(p, e.parry),
    level: i32(p, e.level), isPvP: bool(p, e.isPvP), isArenaBoss: bool(p, e.isArenaBoss), xpWin: i32(p, e.xpWin),
    // which kind of PvP: a ranked match, a friendly, one of the four PvP bosses or Bifidus
    isFriendly: bool(p, e.isFriendlyPvP), isBossPvp: bool(p, e.isBossPvp), bossPvpIndex: i32(p, e.bossPvpIndex), isBifidus: bool(p, e.isBifidus),
    resist: i32(p, e.resistElement), resist2: i32(p, e.resistElement2), weak: i32(p, e.weakElement),
    dropChance: Math.round((f32(p, e.dropChance) || 0) * 1000) / 1000,
  };
}

// PerkModifiers is a class: numeric fields as the game computed them for this fight.
function perkMods(p) {
  const out = {};
  for (const [k, o] of Object.entries(L.perks)) {
    if (o < 0) continue;
    out[k] = k.startsWith('disable') ? bool(p, o) : k === 'flatHealPerHit' ? i32(p, o) : Math.round(f32(p, o) * 10000) / 10000;
  }
  return out;
}

/** Static float read through il2cpp_field_static_get_value (read-only API). */
function staticFloat(ns, cls, field) {
  const info = il2cpp.fieldFromName(klass(ns, cls), cstr(field));
  if (info.isNull()) return null;
  const out = Memory.alloc(8);
  il2cpp.fieldStaticGet(info, out);
  return Math.round(out.readFloat() * 10000) / 10000;
}

/**
 * PerkCatalog.All, the table GetPowerScore(stats, state) sums psWeight from. Read once so the
 * Planner's PWR estimate stays right even if a game update rebalances the perks.
 */
function perkCatalog() {
  const info = il2cpp.fieldFromName(klass('AutoBattle.Data', 'PerkCatalog'), cstr('All'));
  if (info.isNull()) return null;
  const out = Memory.alloc(Process.pointerSize);
  il2cpp.fieldStaticGet(info, out);
  const list = out.readPointer(); // List<PerkData>: _items @0x10, _size @0x18
  if (list.isNull()) return null;
  const items = list.add(0x10).readPointer();
  const size = list.add(0x18).readS32();
  if (items.isNull() || size <= 0 || size > 512) return null;
  const e = layout('AutoBattle.Data', 'PerkData', ['id', 'psWeight', 'tier', 'combatEffect']);
  const perks = [];
  for (let i = 0; i < size; i++) {
    const p = items.add(0x20 + i * 8).readPointer();
    if (p.isNull()) continue;
    // combatEffect is the text StatsCalculator actually parses in a fight; it can differ from the
    // description (Bulwark) and it changes with the balance version
    perks.push({ id: i32(p, e.id), psWeight: i32(p, e.psWeight), tier: i32(p, e.tier), combatEffect: str(ptrAt(p, e.combatEffect)) ?? '' });
  }
  return perks;
}

/** PerkEconomy.IsV2: which of the two perk balance versions the game is running. */
function perkEconomyV2() {
  const info = il2cpp.fieldFromName(klass('AutoBattle.Data', 'PerkEconomy'), cstr('<IsV2>k__BackingField'));
  if (info.isNull()) return null;
  const out = Memory.alloc(8);
  il2cpp.fieldStaticGet(info, out);
  return out.readU8() === 1;
}

/** Static float[] read through il2cpp_field_static_get_value (read-only API). */
function staticFloatArray(ns, cls, field) {
  const info = il2cpp.fieldFromName(klass(ns, cls), cstr(field));
  if (info.isNull()) return null;
  const out = Memory.alloc(Process.pointerSize);
  il2cpp.fieldStaticGet(info, out);
  const arr = out.readPointer();
  if (arr.isNull()) return null;
  const n = arr.add(0x18).readU32(); // Il2CppArray: max_length @0x18, data @0x20
  const values = [];
  for (let i = 0; i < n && i < 64; i++) values.push(Math.round(arr.add(0x20 + i * 4).readFloat() * 10000) / 10000);
  return values;
}
/**
 * System.Collections.Generic.List<int>. Its two fields are mscorlib's, not Assembly-CSharp's, so
 * `layout` cannot resolve them by name and these offsets are the fixed IL2CPP x64 layout:
 * List { _items @0x10, _size @0x18 }, and Il2CppArray data starts at 0x20.
 */
function intList(p, max = 32) {
  if (p.isNull()) return null;
  const items = p.add(0x10).readPointer();
  const size = p.add(0x18).readS32();
  if (items.isNull() || size < 0 || size > max) return null;
  const out = [];
  for (let i = 0; i < size; i++) out.push(items.add(0x20 + i * 4).readS32());
  return out;
}

function snapshot(p) {
  if (p.isNull()) return null;
  const e = L.snapshot;
  return {
    name: str(ptrAt(p, e.playerName)), level: i32(p, e.level), power: i32(p, e.powerScore),
    maxHp: i32(p, e.hp), atk: f32(p, e.atk), def: f32(p, e.def), crit: f32(p, e.crit), parry: f32(p, e.parry),
    perkIds: intList(ptrAt(p, e.equippedPerkIds)), rankingPoints: i32(p, e.rankingPoints),
    mmr: i32(p, e.mmr), matches: i32(p, e.totalPvPMatches),
  };
}

function item(p) {
  if (p.isNull()) return null;
  const e = L.item;
  return {
    uid: i32(p, e.uid), templateId: i32(p, e.templateId), name: str(ptrAt(p, e.itemName)),
    slot: i32(p, e.slot), rarity: i32(p, e.rarity), grantSource: i32(p, e.grantSource),
  };
}
function turn(p) {
  const e = L.turn;
  // heal/counter are indexed by side (player/enemy), not by who is attacking this turn.
  return {
    playerAttacking: bool(p, e.isPlayerAttacking), damage: i32(p, e.damage), crit: bool(p, e.isCrit),
    parried: bool(p, e.isParried), attackerHp: i32(p, e.attackerHpAfter), defenderHp: i32(p, e.defenderHpAfter),
    healPlayer: i32(p, e.healFromEffect), healEnemy: i32(p, e.enemyHealFromEffect),
    counterPlayer: i32(p, e.counterAttackDamage), counterEnemy: i32(p, e.enemyCounterAttackDamage),
    suddenDeath: bool(p, e.suddenDeathActive),
  };
}
function result(p) {
  const e = L.result;
  return {
    won: bool(p, e.playerWon), xp: i32(p, e.xpGained), drop: item(ptrAt(p, e.droppedItem)),
    hpLeft: i32(p, e.remainingPlayerHp), sectorCleared: bool(p, e.sectorCleared), isPvP: bool(p, e.isPvP),
    enemy: str(ptrAt(p, e.enemyName)), rpDelta: i32(p, e.rpDelta), leveledUp: bool(p, e.leveledUp),
    newLevel: i32(p, e.newLevel), levelUpItem: item(ptrAt(p, e.levelUpItem)), sectorBonusItem: item(ptrAt(p, e.sectorBonusItem)),
  };
}

let gameManager = NULL;
let playerState = NULL;
let lastPower = null;
let lastStats = '';
let lastPerks = '';
const xpSeen = {};
const argBool = (v) => (v.toUInt32() & 0xff) === 1;

// IL2CPP x64 ABI: instance methods receive `this` in args[0], parameters next, MethodInfo* last.
// CombatManager.EndBattle/GenerateDropItem are inlined into the combat coroutine and never fire;
// the BattleScreenUI handlers are reached through the OnCombat* delegates, so they always do.
const HOOKS = [
  ['AutoBattle.UI', 'BattleScreenUI', 'HandleCombatStart', 1, {
    onEnter(a) { send({ ev: 'combat_start', enemy: enemy(a[1]) }); } }],
  ['AutoBattle.UI', 'BattleScreenUI', 'HandleCombatTurn', 1, {
    onEnter(a) { send({ ev: 'turn', ...turn(a[1]) }); } }],
  ['AutoBattle.UI', 'BattleScreenUI', 'HandleCombatEnd', 1, {
    onEnter(a) { send({ ev: 'combat_end', ...result(a[1]) }); } }],
  ['AutoBattle.Core', 'GameManager', 'ShowScreen', 1, {
    onEnter(a) { gameManager = a[0]; send({ ev: 'screen', screen: a[1].toInt32() }); } }],
  ['AutoBattle.Core', 'AutoFightController', 'SetOn', 2, {
    onEnter(a) { send({ ev: 'autofight', on: argBool(a[1]), fromPlayer: argBool(a[2]) }); } }],
  ['AutoBattle.Core', 'AutoFightController', 'HandleStaminaDepleted', 0, {
    onEnter() { send({ ev: 'autofight_stamina' }); } }],
  ['AutoBattle.Inventory', 'InventoryManager', 'AddItem', 1, {
    onEnter(a) { send({ ev: 'add_item', item: item(a[1]) }); } }],
  ['AutoBattle.Save', 'SaveSystem', 'Save', 2, {
    onEnter(a) { playerState = a[0]; send({ ev: 'save' }); } }],
  // GetPowerScore(PlayerStats stats /* by ref */, PlayerState state): keep only calls about our player.
  ['AutoBattle.Core', 'StatsCalculator', 'GetPowerScore', 2, {
    onEnter(a) { this.mine = !playerState.isNull() && a[1].equals(playerState); },
    onLeave(r) {
      if (!this.mine) return;
      const v = r.toInt32();
      if (v !== lastPower) { lastPower = v; send({ ev: 'power', value: v }); }
    } }],
  // GetTotalStats(PlayerState, List<ItemData>, bool applyPerks) returns the 20-byte PlayerStats struct
  // through a hidden pointer in args[0]: {int hp; float atk, def, crit, parry}. Final stats, perks included.
  ['AutoBattle.Core', 'StatsCalculator', 'GetTotalStats', 3, {
    onEnter(a) { this.ret = a[0]; this.mine = !playerState.isNull() && a[1].equals(playerState) && (a[3].toUInt32() & 0xff) === 1; },
    onLeave() {
      if (!this.mine) return;
      const r = this.ret;
      const st = { hp: r.readS32(), atk: r.add(4).readFloat(), def: r.add(8).readFloat(), crit: r.add(12).readFloat(), parry: r.add(16).readFloat() };
      const key = JSON.stringify(st);
      if (key !== lastStats) { lastStats = key; send({ ev: 'stats', ...st }); }
    } }],
  // GetPerkModifiers(PlayerState, bool isPvP) -> PerkModifiers: the exact perk numbers used in combat.
  ['AutoBattle.Core', 'PerkCombat', 'GetPerkModifiers', 2, {
    onEnter(a) {
      this.mine = (a[1].toUInt32() & 0xff) === 0 && !playerState.isNull() && a[0].equals(playerState);
      // the loadout these modifiers belong to, read from the same PlayerState the game used: the
      // save lags a perk swap by a battle, so stamping the ids from the save mislabels them
      if (this.mine) this.ids = intList(ptrAt(a[0], L.player.equippedPerkIds));
    },
    onLeave(r) {
      if (!this.mine || r.isNull()) return;
      const mods = perkMods(r);
      const key = JSON.stringify([mods, this.ids]);
      if (key !== lastPerks) { lastPerks = key; send({ ev: 'perk_mods', mods, ids: this.ids }); }
    } }],
  // SnapshotToEnemyState(PlayerSnapshot) runs when the arena turns an opponent into a fight. It is
  // the only place their perks and exact stats are in memory; the replay never records them.
  ['AutoBattle.Steam', 'PlayFabManager', 'SnapshotToEnemyState', 1, {
    onEnter(a) {
      const s = snapshot(a[1]);
      if (s && s.name) send({ ev: 'pvp_snapshot', ...s });
    } }],
  ['AutoBattle.Core', 'XPSystem', 'XPNeededForNextLevel', 1, {
    onEnter(a) { this.level = a[0].toInt32(); },
    onLeave(r) {
      const v = r.toInt32();
      if (xpSeen[this.level] !== v) { xpSeen[this.level] = v; send({ ev: 'xp_needed', level: this.level, value: v }); }
    } }],
];

const listeners = [];
const ok = [];
const failed = [];
for (const [ns, cls, name, argc, callbacks] of HOOKS) {
  try {
    const method = il2cpp.methodFromName(klass(ns, cls), cstr(name), argc);
    if (method.isNull()) throw new Error('method not found');
    listeners.push(Interceptor.attach(method.readPointer(), callbacks)); // MethodInfo.methodPointer
    ok.push(`${cls}.${name}`);
  } catch (e) {
    failed.push(`${cls}.${name}: ${e.message}`);
  }
}

let lastPlayer = '';
let beat = 0;
const timer = setInterval(() => {
  try {
    if (!gameManager.isNull()) {
      const ps = ptrAt(gameManager, L.game.playerState);
      if (!ps.isNull()) playerState = ps;
    }
    if (!playerState.isNull()) {
      const p = L.player;
      const snapshot = {
        level: i32(playerState, p.level), xp: i32(playerState, p.xp),
        stamina: Math.round((f32(playerState, p.stamina) || 0) * 100) / 100,
        hp: i32(playerState, p.currentHp), battleActive: bool(playerState, p.battleActive),
        screen: gameManager.isNull() ? null : i32(gameManager, L.game.currentScreen),
        // what is worn right now: the save only catches up at the end of the next fight
        equipped: p.equippedUids < 0 ? null : intList(ptrAt(playerState, p.equippedUids)),
        perks: p.equippedPerkIds < 0 ? null : intList(ptrAt(playerState, p.equippedPerkIds)),
      };
      const key = JSON.stringify(snapshot);
      if (key !== lastPlayer) { lastPlayer = key; send({ ev: 'player', ...snapshot }); }
    }
  } catch (e) {
    playerState = NULL; // object went away (new game / reload); recaptured on the next Save
  }
  if (++beat % 5 === 0) send({ ev: 'hb' });
}, 1000);

let constants = null;
try {
  constants = {
    regenBaselinePctBySector: staticFloatArray('AutoBattle.Data', 'GameConstants', 'REGEN_BASELINE_PCT_BY_SECTOR'),
    enemyWeakBothWeaponsPct: staticFloat('AutoBattle.Data', 'GameConstants', 'ENEMY_WEAK_BOTH_WEAPONS_PCT'),
    perkWeights: perkCatalog(),
    perkEconomyV2: perkEconomyV2(),
  };
} catch (e) {
  failed.push(`GameConstants: ${e.message}`);
}
send({ ev: 'ready', hooks: { ok, failed }, missingFields, constants });

rpc.exports = {
  dispose() {
    clearInterval(timer);
    listeners.forEach((l) => l.detach());
  },
};
