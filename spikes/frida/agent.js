// Read-only Frida agent for Lootborne: resolves IL2CPP methods BY NAME through the exported
// il2cpp_* API (no hardcoded addresses, survives game updates) and only observes arguments /
// return values. It never writes game memory or changes behaviour.
'use strict';

const ga = Process.getModuleByName('GameAssembly.dll');
const fn = (name, ret, args) => new NativeFunction(ga.getExportByName(name), ret, args);
const il2cpp = {
  domainGet: fn('il2cpp_domain_get', 'pointer', []),
  assemblyOpen: fn('il2cpp_domain_assembly_open', 'pointer', ['pointer', 'pointer']),
  assemblyImage: fn('il2cpp_assembly_get_image', 'pointer', ['pointer']),
  classFromName: fn('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']),
  methodFromName: fn('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']),
};

const image = il2cpp.assemblyImage(
  il2cpp.assemblyOpen(il2cpp.domainGet(), Memory.allocUtf8String('Assembly-CSharp')));

function methodPointer(ns, cls, name, argc) {
  const klass = il2cpp.classFromName(image, Memory.allocUtf8String(ns), Memory.allocUtf8String(cls));
  if (klass.isNull()) throw new Error(`class ${ns}.${cls} not found`);
  const method = il2cpp.methodFromName(klass, Memory.allocUtf8String(name), argc);
  if (method.isNull()) throw new Error(`method ${cls}.${name}/${argc} not found`);
  return method.readPointer(); // MethodInfo.methodPointer
}

// Il2CppString: length at +0x10, UTF-16 chars at +0x14
function str(p) {
  if (p.isNull()) return null;
  const n = p.add(0x10).readS32();
  return n >= 0 && n < 512 ? p.add(0x14).readUtf16String(n) : null;
}

const RARITY = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Ascended'];
const SCREEN = ['Creation', 'Home', 'Equip', 'Inventory', 'Battle'];
const COLOR = ['Grigio', 'Blu', 'Viola'];

// ItemInstance offsets (re/decomp): uid 0x10, templateId 0x14, itemName 0x20, slot 0x28, rarity 0x2C, grantSource 0x54
function item(p) {
  if (p.isNull()) return null;
  return {
    uid: p.add(0x10).readS32(), templateId: p.add(0x14).readS32(), name: str(p.add(0x20).readPointer()),
    slot: p.add(0x28).readS32(), rarity: RARITY[p.add(0x2C).readS32()], grantSource: p.add(0x54).readS32(),
  };
}

// EnemyState offsets: name 0x10, color 0x28, hp 0x2C, maxHp 0x30, level 0x44, isPvP 0x48, xpWin 0x58, dropChance 0x60
function enemy(p) {
  if (p.isNull()) return null;
  return {
    name: str(p.add(0x10).readPointer()), color: COLOR[p.add(0x28).readS32()], maxHp: p.add(0x30).readS32(),
    level: p.add(0x44).readS32(), isPvP: p.add(0x48).readU8() === 1, xpWin: p.add(0x58).readS32(),
    dropChance: Math.round(p.add(0x60).readFloat() * 1000) / 1000,
  };
}

const b = (v) => (v.toUInt32() & 0xff) === 1;

// CombatTurnResult: isPlayerAttacking 0x10, damage 0x28, isCrit 0x2C, isParried 0x2D, attackerHpAfter 0x30, defenderHpAfter 0x34
function turn(p) {
  return {
    playerAttacking: p.add(0x10).readU8() === 1, damage: p.add(0x28).readS32(), crit: p.add(0x2C).readU8() === 1,
    parried: p.add(0x2D).readU8() === 1, attackerHp: p.add(0x30).readS32(), defenderHp: p.add(0x34).readS32(),
  };
}

// CombatResult: playerWon 0x10, xpGained 0x14, droppedItem 0x18, remainingPlayerHp 0x20, sectorCleared 0x24,
// isPvP 0x25, enemyName 0x28, rpDelta 0x30, leveledUp 0x48, newLevel 0x4C, levelUpItem 0x58
function result(p) {
  return {
    won: p.add(0x10).readU8() === 1, xp: p.add(0x14).readS32(), drop: item(p.add(0x18).readPointer()),
    hpLeft: p.add(0x20).readS32(), sectorCleared: p.add(0x24).readU8() === 1, isPvP: p.add(0x25).readU8() === 1,
    enemy: str(p.add(0x28).readPointer()), rpDelta: p.add(0x30).readS32(), leveledUp: p.add(0x48).readU8() === 1,
    newLevel: p.add(0x4C).readS32(), levelUpItem: item(p.add(0x58).readPointer()),
  };
}
const hooks = [
  // IL2CPP x64 ABI: instance methods get `this` in args[0]; params follow; MethodInfo* last.
  ['AutoBattle.Combat', 'CombatManager', 'StartPvEBattle', 0, {
    onEnter() { send({ ev: 'pve_start' }); } }],
  // CombatManager.EndBattle/GenerateDropItem are inlined into the combat coroutine (hooks never
  // fire); BattleScreenUI handlers are invoked through the OnCombat* delegates, so they are not.
  ['AutoBattle.UI', 'BattleScreenUI', 'HandleCombatStart', 1, {
    onEnter(a) { send({ ev: 'combat_start', enemy: enemy(a[1]) }); } }],
  ['AutoBattle.UI', 'BattleScreenUI', 'HandleCombatTurn', 1, {
    onEnter(a) { send({ ev: 'turn', ...turn(a[1]) }); } }],
  ['AutoBattle.UI', 'BattleScreenUI', 'HandleCombatEnd', 1, {
    onEnter(a) { send({ ev: 'combat_end', ...result(a[1]) }); } }],
  ['AutoBattle.Inventory', 'InventoryManager', 'AddItem', 1, {
    onEnter(a) { send({ ev: 'add_item', item: item(a[1]) }); } }],
  ['AutoBattle.Core', 'GameManager', 'ShowScreen', 1, {
    onEnter(a) { send({ ev: 'screen', screen: SCREEN[a[1].toInt32()] }); } }],
  ['AutoBattle.Core', 'AutoFightController', 'SetOn', 2, {
    onEnter(a) { send({ ev: 'autofight_set', on: b(a[1]), fromPlayer: b(a[2]) }); } }],
  ['AutoBattle.Core', 'AutoFightController', 'HandleStaminaDepleted', 0, {
    onEnter() { send({ ev: 'autofight_stamina_depleted' }); } }],
  ['AutoBattle.Save', 'SaveSystem', 'Save', 2, {
    onEnter() { send({ ev: 'save' }); } }],
];

const installed = [];
for (const [ns, cls, name, argc, cb] of hooks) {
  try {
    const ptr = methodPointer(ns, cls, name, argc);
    installed.push(Interceptor.attach(ptr, cb));
    send({ ev: 'hooked', method: `${cls}.${name}`, rva: '0x' + ptr.sub(ga.base).toString(16) });
  } catch (e) {
    send({ ev: 'hook_failed', method: `${cls}.${name}`, error: String(e) });
  }
}

rpc.exports = {
  dispose() { installed.forEach((l) => l.detach()); },
};
