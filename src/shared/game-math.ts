// Game formulas recovered from the IL2CPP build (re/isil, re/decomp) - build c4889dfe.
import { ELEMENTS, RARITIES, type Rarity, type SaveItem, type SaveState } from './contracts';

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
}

/** StatsCalculator.GetBaseStats - flat, does not scale with level. */
export const BASE_STATS: Stats = { hp: 400, atk: 8, def: 5, crit: 5, parry: 3 };

/** StatsCalculator..cctor: value of one allocated stat point. */
export const PER_POINT: Stats = { hp: 3.2, atk: 0.2, def: 0.8, crit: 0.3, parry: 0.25 };

/** StatsCalculator.GetPowerScore weights and caps (GameAssembly .rdata). */
export const POWER_WEIGHTS: Stats = { hp: 0.8, atk: 9, def: 6, crit: 6, parry: 8 };
export const POWER_CAPS = { crit: 60, parry: 55 };

const STAT_KEYS = ['hp', 'atk', 'def', 'crit', 'parry'] as const;
const SHIELD_RE = /shield|scudo|buckler|aegis|bulwark|barrier/i;
const STAT_RE = /([+-]?\d+(?:\.\d+)?)\s*%?\s*(HP|ATK|DEF|CRIT|PARRY)\b/g;

export function emptyStats(): Stats {
  return { hp: 0, atk: 0, def: 0, crit: 0, parry: 0 };
}

export function addStats(into: Stats, from: Partial<Stats>, times = 1): Stats {
  for (const k of STAT_KEYS) into[k] += (from[k] ?? 0) * times;
  return into;
}

/** "+0.8% CRIT and +1.3 ATK" -> { crit: 0.8, atk: 1.3 } */
export function parseStatList(text: string): Partial<Stats> {
  const out: Partial<Stats> = {};
  for (const m of text.matchAll(STAT_RE)) {
    const key = m[2]!.toLowerCase() as keyof Stats;
    out[key] = (out[key] ?? 0) + Number(m[1]);
  }
  return out;
}

/**
 * GameConstants.InventoryCapForLevel: the bag grows with the character — 150 slots, 200 from level
 * 30 (INVENTORY_CAP_T2_LEVEL), 300 from level 60 (T3). RestNotices.InventoryCapNow uses the same.
 */
export function inventoryCapForLevel(level: number): number {
  return level >= 60 ? 300 : level >= 30 ? 200 : 150;
}

/** GameConstants.MAX_LEVEL; GameManager.EffectiveMaxLevel returns it in the full game (10 in the demo). */
export const MAX_LEVEL = 60;

/**
 * XPSystem's level curve. XpAnchorLevel / XpAnchorBase are two int[21] the static constructor fills
 * from global-metadata.dat; XpBaseAtLevel is exact on an anchor and geometric in between (logf, lerp,
 * expf, all float32), and XPNeededForNextLevel(L) = XPForLevel(L + 1) = (int)(XpBaseAtLevel(L) × 45).
 * The same base is what a PvP win pays (a loss pays a quarter), and the bases are the Viola/Blu/Grigio
 * xpBase of each sector's first enemy. Checked on our own level-ups 27→55: the XP banked between two
 * of them is 97–100% of this (each level-up carries some overflow).
 */
const XP_ANCHOR_LEVEL = [1, 3, 5, 7, 9, 11, 14, 17, 20, 23, 26, 29, 32, 36, 40, 43, 47, 51, 53, 56, 59];
const XP_ANCHOR_BASE = [15, 100, 250, 366, 574, 824, 1590, 2255, 3020, 6000, 7500, 9200, 12672, 15664, 18936, 31154, 36562, 42354, 66338, 73254, 80465];
const XP_FOR_LEVEL_MULT = 45;

export function xpBaseAtLevel(level: number): number {
  const L = XP_ANCHOR_LEVEL;
  const B = XP_ANCHOR_BASE;
  if (level <= L[0]!) return B[0]!;
  if (level >= L[L.length - 1]!) return B[B.length - 1]!;
  const f = Math.fround;
  for (let i = 0; i < L.length - 1; i++) {
    if (level === L[i]) return B[i]!;
    if (level > L[i]! && level < L[i + 1]!) {
      const t = f(f(level - L[i]!) / f(L[i + 1]! - L[i]!));
      const a = f(Math.log(B[i]!));
      const b = f(Math.log(B[i + 1]!));
      return f(Math.exp(f(f(f(b - a) * t) + a)));
    }
  }
  return B[B.length - 1]!;
}

/** XPSystem.XPNeededForNextLevel: the size of the XP bar at `level`; Infinity at the cap. */
export function xpNeededForNextLevel(level: number): number {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.trunc(Math.fround(xpBaseAtLevel(Math.max(1, level)) * XP_FOR_LEVEL_MULT));
}

/**
 * XP still to bank to reach `target`: the rest of the current bar plus every bar after it. `neededNow`
 * is the current bar as the game reported it (the live tap), when we have it.
 */
export function xpToLevel(level: number, xp: number, target = MAX_LEVEL, neededNow?: number): number {
  if (level >= target) return 0;
  let left = Math.max(0, (neededNow ?? xpNeededForNextLevel(level)) - xp);
  for (let l = level + 1; l < target; l++) left += xpNeededForNextLevel(l);
  return left;
}

export function isShield(item: Pick<SaveItem, 'itemName'>): boolean {
  return SHIELD_RE.test(item.itemName);
}

export function powerScore(s: Stats, perkWeight = 0): number {
  const raw =
    s.hp * POWER_WEIGHTS.hp +
    s.atk * POWER_WEIGHTS.atk +
    s.def * POWER_WEIGHTS.def +
    Math.min(s.crit, POWER_CAPS.crit) * POWER_WEIGHTS.crit +
    Math.min(s.parry, POWER_CAPS.parry) * POWER_WEIGHTS.parry;
  return Math.max(0, Math.trunc(raw)) + perkWeight;
}

export interface EquippedSlot {
  slot: string;
  item: SaveItem | null;
}

export function equippedItems(state: Pick<SaveState, 'equippedSlots' | 'equippedUids' | 'inventory'>): EquippedSlot[] {
  const byUid = new Map(state.inventory.map((i) => [i.uid, i]));
  return state.equippedSlots.map((slot, idx) => ({ slot, item: byUid.get(state.equippedUids[idx] ?? -1) ?? null }));
}

/**
 * "For every other X item" pays this much more than the text says (StatsCalculator, .rdata 1.3f).
 * The text is the per-item value; the game multiplies count × value × 1.3.
 */
export const SYNERGY_MULT = 1.3;

/** HP, ATK and DEF synergy bonuses are truncated to an integer (cvttss2si); CRIT and PARRY are not. */
const TRUNCATES: Record<keyof Stats, boolean> = { hp: true, atk: true, def: true, crit: false, parry: false };

/** One matched effect: `parsed` scaled by `times` and `mult`, truncated the way the game truncates. */
function addSynergy(into: Stats, parsed: Partial<Stats>, times = 1, mult = 1): void {
  for (const k of STAT_KEYS) {
    const raw = (parsed[k] ?? 0) * times * mult;
    if (raw) into[k] += TRUNCATES[k] ? Math.trunc(raw) : raw;
  }
}

/**
 * Static synergy bonuses parsed from effect strings, the way StatsCalculator.ApplySynergyBonuses and
 * ApplyCrossSynergyBonuses do — both were read turn by turn from the running game to get this right.
 * Conditional/proc effects (below X% HP, every N attacks, on crit...) are not static and are ignored.
 */
export function synergyBonus(items: SaveItem[]): { bonus: Stats; modelled: number; ignored: number } {
  const bonus = emptyStats();
  let modelled = 0;
  let ignored = 0;
  const weapons = items.filter((i) => i.slot === 3);
  const dualWield = weapons.length >= 2 && weapons.every((w) => !isShield(w));
  const hasShield = weapons.some(isShield);
  const countOf = (element: string) => items.filter((o) => ELEMENTS[o.category] === element).length;
  // ApplyCrossSynergyBonuses takes a `categoryCount` argument and multiplies the parsed stats by it.
  // We read it as the distinct *elemental* categories worn, i.e. Nessuna does not count as one — the
  // ISIL is too coarse to confirm that, and no item we own uses this clause yet, so it is untested
  // against the live game.
  const categoryCount = new Set(items.filter((o) => o.category > 0).map((o) => o.category)).size;
  for (const item of items) {
    const element = ELEMENTS[item.category] ?? 'Nessuna';
    const others = items.filter((o) => o.uid !== item.uid);
    for (const effect of item.effects) {
      let m: RegExpMatchArray | null;
      if ((m = effect.match(/^For every other\s+(\w+)\s+item:\s*(.+)$/i)) || (m = effect.match(/^For each other item\s+(\w+):\s*(.+)$/i))) {
        // the game reads elementalCounts[element] and always subtracts one, whatever the bearer is
        addSynergy(bonus, parseStatList(m[2]!), Math.max(0, countOf(m[1]!) - 1), SYNERGY_MULT);
        modelled++;
      } else if ((m = effect.match(/^If equipped with an item of a different element:\s*(.+)$/i))) {
        const ok = others.some((o) => o.category !== 0 && ELEMENTS[o.category] !== element);
        if (ok) addSynergy(bonus, parseStatList(m[1]!));
        modelled++;
      } else if ((m = effect.match(/^If equipped with an? (Arcane|Flame|Frost|Holy|Shadow) item:\s*(.+)$/i))) {
        if (others.some((o) => ELEMENTS[o.category] === m![1])) addSynergy(bonus, parseStatList(m[2]!));
        modelled++;
      } else if ((m = effect.match(/^If dual wielding weapons:\s*(.+)$/i))) {
        if (dualWield) addSynergy(bonus, parseStatList(m[1]!));
        modelled++;
      } else if ((m = effect.match(/^If equipped with ([^:]+):\s*(.+)$/i))) {
        // The catch-all the game falls through to: "a Shield", or one or more item names split on
        // " or ". Only reached after the element clauses above, exactly as ApplyCrossSynergyBonuses
        // orders them.
        const who = m[1]!.trim();
        const ok = who.startsWith('a Shield')
          ? hasShield
          : who.split(' or ').some((n) => others.some((o) => o.itemName === n.trim()));
        if (ok) addSynergy(bonus, parseStatList(m[2]!));
        modelled++;
      } else if ((m = effect.match(/^For every different element category equipped:\s*(.+)$/i))) {
        if (categoryCount > 0) addSynergy(bonus, parseStatList(m[1]!), categoryCount);
        modelled++;
      } else {
        ignored++;
      }
    }
  }
  return { bonus, modelled, ignored };
}

/** The perk fields StatsCalculator.GetTotalStats reads. Everything else only matters in combat. */
export interface PerkStatMods {
  defToAtkPct?: number;
  atkFlat?: number;
  atkPct?: number;
  defPct?: number;
  defPctPerParryPoint?: number;
  maxHpPct?: number;
  critFlat?: number;
}

/**
 * The tail of GetTotalStats, in its exact order: DEF bleeds into ATK first, then the flat and
 * percentage ATK, then DEF (parry can feed it), then max HP (rounded), then flat CRIT.
 */
export function applyPerkStats(s: Stats, m: PerkStatMods | undefined): Stats {
  if (!m) return { ...s };
  let atk = s.atk;
  if ((m.defToAtkPct ?? 0) > 0) atk += s.def * m.defToAtkPct!;
  atk += m.atkFlat ?? 0;
  atk *= 1 + (m.atkPct ?? 0);
  const defPct = (m.defPct ?? 0) + ((m.defPctPerParryPoint ?? 0) > 0 ? Math.min(s.parry, POWER_CAPS.parry) * m.defPctPerParryPoint! : 0);
  return {
    hp: Math.max(1, Math.round(s.hp * (1 + (m.maxHpPct ?? 0)))),
    atk,
    def: s.def * (1 + defPct),
    crit: s.crit + (m.critFlat ?? 0),
    parry: s.parry,
  };
}

export interface BuildEstimate {
  /** final stats, perks included when we know them */
  stats: Stats;
  /** GetPowerScore(stats, state): the stat score plus the perks' psWeight */
  power: number;
  items: Stats;
  synergy: Stats;
  allocated: Stats;
  /** base + items + synergy + points, before any perk touches it */
  beforePerks: Stats;
  /** what the perks changed */
  perks: Stats;
  /** the perks' fixed contribution to PWR (PerkSystem.GetTotalPerkPsWeight) */
  perkPower: number;
  modelledEffects: number;
  ignoredEffects: number;
}

export interface BuildPerks {
  /** PerkCombat.GetPerkModifiers, live or from our own table */
  mods?: PerkStatMods;
  /** sum of PerkData.psWeight over the equipped perks */
  weight?: number;
}

export function estimateBuild(
  state: SaveState,
  items = equippedItems(state).flatMap((e) => (e.item ? [e.item] : [])),
  perks: BuildPerks = {},
): BuildEstimate {
  const itemStats = items.reduce((acc, i) => addStats(acc, i), emptyStats());
  const syn = synergyBonus(items);
  const allocated: Stats = {
    hp: state.allocatedHp * PER_POINT.hp,
    atk: state.allocatedAtk * PER_POINT.atk,
    def: state.allocatedDef * PER_POINT.def,
    crit: state.allocatedCrit * PER_POINT.crit,
    parry: state.allocatedParry * PER_POINT.parry,
  };
  const beforePerks = addStats(addStats(addStats(addStats(emptyStats(), BASE_STATS), itemStats), syn.bonus), allocated);
  const stats = applyPerkStats(beforePerks, perks.mods);
  const perkPower = perks.weight ?? 0;
  return {
    stats,
    power: powerScore(stats, perkPower),
    items: itemStats,
    synergy: syn.bonus,
    allocated,
    beforePerks,
    perks: {
      hp: stats.hp - beforePerks.hp,
      atk: stats.atk - beforePerks.atk,
      def: stats.def - beforePerks.def,
      crit: stats.crit - beforePerks.crit,
      parry: stats.parry - beforePerks.parry,
    },
    perkPower,
    modelledEffects: syn.modelled,
    ignoredEffects: syn.ignored,
  };
}

export interface Upgrade {
  item: SaveItem;
  slot: string;
  replaces: SaveItem | null;
  powerDelta: number;
  /** total stats with the swap applied, and what changed */
  stats: Stats;
  delta: Stats;
  /** the part of `delta` that comes from synergies turning on or off, not from the item's own stats */
  synergyDelta: Stats;
  /** PWR the synergy change alone is worth */
  synergyPower: number;
  effectsGained: string[];
  effectsLost: string[];
}

function subStats(a: Stats, b: Stats): Stats {
  return { hp: a.hp - b.hp, atk: a.atk - b.atk, def: a.def - b.def, crit: a.crit - b.crit, parry: a.parry - b.parry };
}

export function hasStatChange(s: Stats, eps = 0.001): boolean {
  return STAT_KEYS.some((k) => Math.abs(s[k]) > eps);
}

/** Puts `item` in slot `idx` and reports everything that changes. */
function evaluate(state: SaveState, equipped: EquippedSlot[], idx: number, item: SaveItem, base: BuildEstimate, perks: BuildPerks): Upgrade {
  const items = equipped.flatMap((x, j) => (j === idx ? [item] : x.item ? [x.item] : []));
  const next = estimateBuild(state, items, perks);
  const replaces = equipped[idx]!.item;
  const synergyDelta = subStats(next.synergy, base.synergy);
  // what the synergy change alone is worth, measured at the new stat level
  const withoutSynergyChange = addStats({ ...next.stats }, synergyDelta, -1);
  return {
    item,
    slot: equipped[idx]!.slot,
    replaces,
    powerDelta: next.power - base.power,
    stats: next.stats,
    delta: subStats(next.stats, base.stats),
    synergyDelta,
    synergyPower: next.power - powerScore(withoutSynergyChange),
    effectsGained: item.effects.filter((e) => !replaces?.effects.includes(e)),
    effectsLost: (replaces?.effects ?? []).filter((e) => !item.effects.includes(e)),
  };
}

/** Every unequipped item that fits a slot, with what it would change there. */
function candidatesFor(state: SaveState, equipped: EquippedSlot[], idx: number, base: BuildEstimate, perks: BuildPerks): Upgrade[] {
  const slot = equipped[idx]!.slot;
  const equippedUids = new Set(state.equippedUids);
  const out: Upgrade[] = [];
  for (const item of state.inventory) {
    if (equippedUids.has(item.uid)) continue;
    const slotName = ITEM_SLOT_NAMES[item.slot] ?? '';
    if (!slot.startsWith(slotName)) continue;
    if (isShield(item) && slot !== 'Arma 2') continue; // shields only in Arma 2
    out.push(evaluate(state, equipped, idx, item, base, perks));
  }
  return out.sort((a, b) => b.powerDelta - a.powerDelta);
}

const ITEM_SLOT_NAMES = ['Testa', 'Corpo', 'Cintura', 'Arma', 'Anello', 'Trinket'];

export interface SlotUpgrades {
  slot: string;
  current: SaveItem | null;
  options: Upgrade[];
}

/** The inventory seen slot by slot: what is equipped there and what else would fit. */
export function upgradesBySlot(state: SaveState, perks: BuildPerks = {}): SlotUpgrades[] {
  const equipped = equippedItems(state);
  const base = estimateBuild(state, undefined, perks);
  return equipped.map((e, idx) => ({ slot: e.slot, current: e.item, options: candidatesFor(state, equipped, idx, base, perks) }));
}

/** For every unequipped item, the best slot to put it in and the resulting PWR change. */
export function upgradeCandidates(state: SaveState, perks: BuildPerks = {}): Upgrade[] {
  const best = new Map<number, Upgrade>();
  for (const { options } of upgradesBySlot(state, perks)) {
    for (const u of options) {
      const prev = best.get(u.item.uid);
      if (!prev || u.powerDelta > prev.powerDelta) best.set(u.item.uid, u);
    }
  }
  return [...best.values()].sort((a, b) => b.powerDelta - a.powerDelta);
}

export function rarityName(index: number): Rarity {
  return RARITIES[index] ?? 'Common';
}

export function rarityIndex(r: Rarity): number {
  return RARITIES.indexOf(r);
}
