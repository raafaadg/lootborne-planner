// Lootborne combat model, recovered from the IL2CPP build (re/isil CombatManager.ResolveAttack,
// PickEnemyForBattle, PickCategoryByGaussian, GameConstants) and checked against live turns.
//
//   hit lands     unless Random.value < defender PARRY / 100
//   crit          Random.value < min(attacker CRIT, cap) / 100            -> x2 damage
//   damage        max(1, RoundToInt(ATK * U(0.8, 1.2) * crit * mult * 60 / (60 + DEF)))
//   turns         strictly alternating, player first, 0.5 s / GAME_SPEED 1.25 = 0.4 s each
//   after a win   HP += RoundToInt(maxHp * REGEN_BASELINE_PCT_BY_SECTOR[sector]) + item "Regeneration: +N HP"
//   death         sector progress back to enemy 0 (DEATH_CHECKPOINT_KEEP_FRAC = 0), HP refilled
//   sudden death  PvP only (CombatRuntimeEffects.isPvP), so PvE fights have no turn limit

import type { SaveItem } from './contracts';
import { parseProcs, type BelowHp, type Procs } from './item-effects';

export const COMBAT = {
  DEF_K: 60,
  CRIT_MULT: 2,
  DMG_MIN: 0.8,
  DMG_MAX: 1.2,
  TURN_SECONDS: 0.5 / 1.25,
  /** combat_end -> next combat_start measured live (PAUSE_BETWEEN_BATTLES 2 s + animations). */
  PAUSE_SECONDS: 2.4,
  CRIT_CAP: 60,
  PARRY_CAP: 55,
  /** GameConstants.REGEN_BASELINE_PCT_BY_SECTOR, read live by the agent; this is the fallback. */
  REGEN_PCT_BY_SECTOR: [0.09, 0.13, 0.13, 0.12, 0.09, 0.07, 0.09],
  /** Safety valve for pathological builds; PvE has no real turn limit. */
  MAX_TURNS: 4000,
  /** GameConstants.ENEMY_RESIST_PCT: each weapon on the weakness +15 %, each resisted -15 %. */
  ELEMENT_PCT: 0.15,
  /** GameConstants.ENEMY_WEAK_BOTH_WEAPONS_PCT (read live): both weapons on the weakness. */
  WEAK_BOTH_PCT: 0.4,
  /** GameConstants.XP_SCALING_PENALTY / XP_OVERLEVEL_FREE_BAND / XP_SCALING_MIN. */
  XP_PENALTY_PER_LEVEL: 0.12,
  XP_FREE_BAND: 3,
  XP_SCALING_MIN: 0,
  /**
   * GameConstants.SECTOR_INTENDED_LEVEL (the array's bytes, from global-metadata.dat): the level the
   * over-level penalty is measured from when the enemy itself is lower.
   */
  SECTOR_INTENDED_LEVEL: [3, 9, 17, 26, 36, 47, 56],
};

/** GameConstants.SectorIntendedLevel: the table, clamped to its last sector like the game does. */
export function sectorIntendedLevel(sectorId: number): number {
  const t = COMBAT.SECTOR_INTENDED_LEVEL;
  return t[Math.max(0, Math.min(t.length - 1, sectorId))]!;
}

/**
 * What an enemy actually pays once we have out-levelled it: XPSystem.ScaleXPForSector.
 *
 * Three levels of grace, then 12 percentage points per level, down to nothing — counted from the
 * enemy's level or the sector's intended level, whichever is higher. So a sector's weakest enemies
 * pay like its intended level: at level 55 in Sector 5 (intended 47) the level-43 Deserter pays 40%,
 * the same as the level-47 one. Checked on 594 won fights of our own at levels 53–55 (every payout
 * matches); counting from the enemy's level alone matched 107 of them.
 *
 * Leave `sectorId` out and only the enemy's level counts (the old reading).
 */
export function xpMultiplier(playerLevel: number, enemyLevel: number, sectorId?: number): number {
  const ref = sectorId === undefined ? enemyLevel : Math.max(enemyLevel, sectorIntendedLevel(sectorId));
  const over = Math.max(0, playerLevel - ref - COMBAT.XP_FREE_BAND);
  return Math.max(COMBAT.XP_SCALING_MIN, 1 - COMBAT.XP_PENALTY_PER_LEVEL * over);
}

export const ELEMENT_NAMES = ['Nessuna', 'Arcane', 'Flame', 'Frost', 'Holy', 'Shadow'] as const;
export type ElementName = (typeof ELEMENT_NAMES)[number];

export const PER_POINT = { hp: 3.2, atk: 0.2, def: 0.8, crit: 0.3, parry: 0.25 } as const;
export type StatKey = keyof typeof PER_POINT;
export const STAT_KEYS: StatKey[] = ['atk', 'def', 'hp', 'crit', 'parry'];

export interface EnemyVariant {
  color: 'Grigio' | 'Blu' | 'Viola';
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
  level: number;
  xpBase: number;
}

export interface EnemyCategory {
  pathId: number;
  name: string;
  variants: EnemyVariant[];
  /** ElementCategory names; 'Nessuna' = none. */
  resist: ElementName;
  resist2: ElementName;
  weak: ElementName;
}

/** A variant carrying its category's elements, cached so identity stays stable for the caches. */
export type SectorEnemy = EnemyVariant & { name: string; resist: ElementName; resist2: ElementName; weak: ElementName };

const enemyCache = new Map<string, SectorEnemy>();
export function sectorEnemy(cat: EnemyCategory, color: EnemyVariant['color']): SectorEnemy {
  const key = `${cat.pathId}|${color}`;
  const hit = enemyCache.get(key);
  if (hit) return hit;
  const v = cat.variants.find((x) => x.color === color) ?? cat.variants[0]!;
  const made: SectorEnemy = { ...v, name: cat.name, resist: cat.resist, resist2: cat.resist2, weak: cat.weak };
  enemyCache.set(key, made);
  return made;
}

/**
 * ResolveAttack: each equipped weapon whose element matches the enemy's weakness adds
 * ENEMY_RESIST_PCT, each one matching a resistance subtracts it; both weapons on the weakness use
 * ENEMY_WEAK_BOTH_WEAPONS_PCT instead. Only the player's damage is affected.
 */
export function elementMultiplier(
  weapons: readonly ElementName[],
  e: { resist?: ElementName; resist2?: ElementName; weak?: ElementName },
  weakBothPct = COMBAT.WEAK_BOTH_PCT,
  ignoreResist = false,
): number {
  let weak = 0;
  let resisted = 0;
  for (const el of weapons) {
    if (!el || el === 'Nessuna') continue;
    if (e.weak && el === e.weak) weak++;
    else if (!ignoreResist && ((e.resist && el === e.resist) || (e.resist2 && el === e.resist2))) resisted++;
  }
  const bonus = weak >= 2 ? weakBothPct : weak * COMBAT.ELEMENT_PCT;
  return 1 + bonus - resisted * COMBAT.ELEMENT_PCT;
}

export interface SectorInfo {
  id: number;
  name: string;
  totalEnemies: number;
  categories: number[];
}

export interface PlayerProfile {
  maxHp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
  critCap: number;
  healPerLandedHit: number;
  lifestealPct: number;
  healOnCrit: number;
  regenEvery: Array<{ seconds: number; amount: number }>;
  regenPerFight: number;
  damageDealtMult: number;
  damageTakenMult: number;
  flatDamagePerHit: number;
  enemyCritDamageReduction: number;
  disableHealing: boolean;
  /** Elements of Arma 1 / Arma 2 (the only ones that matter for weakness and resistance). */
  weaponElements: ElementName[];
  /** GameConstants.ENEMY_WEAK_BOTH_WEAPONS_PCT, read live when available. */
  weakBothPct: number;
  // ---- what potions add (ConsumableModifiers); all zero/1/false without them ----
  /** armour penetration: the enemy fights with this fraction of its DEF removed */
  enemyDefIgnorePct: number;
  /** the enemy starts with this fraction of its HP */
  enemyHpMult: number;
  /** extra damage while the enemy is below half its HP */
  executeBelowHpBonus: number;
  /** fraction of the enemy's max HP that burns away each turn */
  immolationPctPerTurn: number;
  /** DEF the enemy loses every other landed hit, stacking within the fight */
  sunderPerHit: number;
  /** our attacks ignore the enemy's elemental resistances */
  ignoreResist: boolean;
  /** everything the equipped items do during a fight (item-effects.ts) */
  procs: Procs;
}

export const DROP_CHANCE_BY_COLOR = { Grigio: 0.08, Blu: 0.12, Viola: 0.2 } as const;

// ---- primitives ----------------------------------------------------------------------------

/** Mathf.RoundToInt is Math.Round: halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5 + 1e-9) return f + 1;
  if (d < 0.5 - 1e-9) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function hitDamage(atk: number, def: number, crit: boolean, u: number, mult = 1, flat = 0): number {
  const raw = (atk * u * (crit ? COMBAT.CRIT_MULT : 1) + flat) * mult * (COMBAT.DEF_K / (COMBAT.DEF_K + Math.max(0, def)));
  return Math.max(1, roundHalfEven(raw));
}

const U_STEPS = 160;
/** E[damage | the hit lands], integrating the U(0.8, 1.2) roll and the crit roll exactly enough. */
export function expectedHit(atk: number, def: number, critChance: number, mult = 1, flat = 0, critMult = COMBAT.CRIT_MULT): number {
  const k = mult * (COMBAT.DEF_K / (COMBAT.DEF_K + Math.max(0, def)));
  const c = Math.min(Math.max(critChance, 0), 1);
  // the hit is linear in the U(0.8, 1.2) roll, so its mean is the hit at u = 1 — the rounding and the
  // 1-damage floor only move it when the smallest roll is a couple of points; then integrate
  if ((atk * COMBAT.DMG_MIN + flat) * k >= 3) return ((1 - c) * (atk + flat) + c * (atk * critMult + flat)) * k;
  let normal = 0;
  let crit = 0;
  for (let i = 0; i < U_STEPS; i++) {
    const u = COMBAT.DMG_MIN + ((COMBAT.DMG_MAX - COMBAT.DMG_MIN) * (i + 0.5)) / U_STEPS;
    normal += hitDamage(atk, def, false, u, mult, flat);
    const rawCrit = (atk * u * critMult + flat) * mult * (COMBAT.DEF_K / (COMBAT.DEF_K + Math.max(0, def)));
    crit += Math.max(1, roundHalfEven(rawCrit));
  }
  return ((1 - c) * normal + c * crit) / U_STEPS;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- sector roster (CombatManager.PickEnemyForBattle / PickCategoryByGaussian) -------------

export function categoryWeights(count: number, progress: number): number[] {
  if (count <= 1) return [1];
  const sigma = 0.5 / count;
  const twoSigmaSq = 2 * sigma * sigma;
  const w = Array.from({ length: count }, (_, i) => Math.exp(-((progress - (i + 0.5) / count) ** 2) / twoSigmaSq));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

export function colorProbs(catIndex: number, count: number, progress: number): { Grigio: number; Blu: number; Viola: number } {
  let local = progress;
  if (count > 1) {
    const lo = Math.max(0, (catIndex - 0.5) / count);
    const hi = Math.min(1, (catIndex + 1.5) / count);
    if (hi - lo > 0) local = Math.min(1, Math.max(0, (progress - lo) / (hi - lo)));
  }
  if (local < 0.3) return { Grigio: 0.8, Blu: 0.2, Viola: 0 };
  if (local < 0.7) return { Grigio: 0.3, Blu: 0.45, Viola: 0.25 };
  return { Grigio: 0, Blu: 0.65, Viola: 0.35 };
}

export interface RosterEntry {
  category: EnemyCategory;
  catIndex: number;
  variant: SectorEnemy;
  prob: number;
}

/** Every enemy that can appear at `index` of the sector, with its probability. */
export function rosterAt(sector: SectorInfo, cats: EnemyCategory[], index: number): RosterEntry[] {
  const progress = Math.min(1, Math.max(0, index / Math.max(1, sector.totalEnemies)));
  const weights = categoryWeights(cats.length, progress);
  const out: RosterEntry[] = [];
  cats.forEach((category, catIndex) => {
    const w = weights[catIndex]!;
    if (w < 1e-6) return;
    const cp = colorProbs(catIndex, cats.length, progress);
    for (const color of ['Grigio', 'Blu', 'Viola'] as const) {
      if (cp[color] > 0) out.push({ category, catIndex, variant: sectorEnemy(category, color), prob: w * cp[color] });
    }
  });
  return out;
}

export function sectorCategories(sector: SectorInfo, all: EnemyCategory[]): EnemyCategory[] {
  return sector.categories.map((id) => all.find((c) => c.pathId === id)).filter((c): c is EnemyCategory => Boolean(c));
}

function rollEnemy(sector: SectorInfo, cats: EnemyCategory[], index: number, rng: () => number): SectorEnemy {
  const roster = rosterAt(sector, cats, index);
  let r = rng();
  for (const e of roster) {
    r -= e.prob;
    if (r <= 0) return e.variant;
  }
  return roster[roster.length - 1]!.variant;
}

// ---- one fight -----------------------------------------------------------------------------

export interface FightResult {
  won: boolean;
  turns: number;
  endHp: number;
  seconds: number;
  damageTaken: number;
  healed: number;
  /** the enemy HP taken off, every source counted (hits, counters, reflect, burn, poison) */
  dealt: number;
}

/** What an attack carries from earlier procs: a parry's guaranteed crit, "every N attacks" bonuses. */
export interface PendingMods {
  damagePct: number;
  flat: number;
  ignoreDefPct: number;
  critPct: number;
  crit: boolean;
  mult: number;
  ignoreParry: boolean;
  ignoreDef: boolean;
}

/** An attack that was parried keeps its armed mods; they stack with anything armed meanwhile. */
export function mergePending(a: PendingMods, b: PendingMods): PendingMods {
  return {
    damagePct: a.damagePct + b.damagePct,
    flat: a.flat + b.flat,
    ignoreDefPct: Math.max(a.ignoreDefPct, b.ignoreDefPct),
    critPct: a.critPct + b.critPct,
    crit: a.crit || b.crit,
    mult: Math.max(a.mult, b.mult),
    ignoreParry: a.ignoreParry || b.ignoreParry,
    ignoreDef: a.ignoreDef || b.ignoreDef,
  };
}

/** `maxTurns`: where the fight is cut off (the Arena's time budget); PvE has no real limit. */
export function simulateFight(p: PlayerProfile, startHp: number, e: EnemyVariant | SectorEnemy, rng: () => number, maxTurns: number = COMBAT.MAX_TURNS): FightResult {
  const x = p.procs;
  const dealtMult = p.damageDealtMult * elementMultiplier(p.weaponElements, e as SectorEnemy, p.weakBothPct, p.ignoreResist);
  let hp = startHp;
  const enemyMaxHp = Math.max(1, Math.round(e.hp * p.enemyHpMult));
  let enemyHp = enemyMaxHp;
  const penetration = Math.min(0.75, p.enemyDefIgnorePct + x.ignoreDefPct);
  let enemyDef = Math.max(0, e.def * (1 - penetration));
  const burn = p.immolationPctPerTurn > 0 ? Math.max(1, roundHalfEven(enemyMaxHp * p.immolationPctPerTurn)) : 0;
  let landed = 0;
  let attacks = 0;
  let crits = 0;
  let hitsTaken = 0;
  let defBonus = 0; // "on parry: +N DEF for the rest of combat"
  // what runs out: the enemy DEF debuffs our crits push, and our DEF buffs from parries
  const defDebuffs: Array<{ amount: number; until: number }> = [];
  const parryDefs: Array<{ amount: number; until: number }> = [];
  const active = (list: Array<{ amount: number; until: number }>, now: number) => {
    let sum = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.until > now) sum += list[i]!.amount;
      else list.splice(i, 1);
    }
    return sum;
  };
  // "Every N sec: +N temporary ATK / DEF / to all stats": piles up for the whole fight
  const timers = x.everyNSec.filter((r) => r.atk || r.def || r.allStats).map((r) => ({ ...r, stacks: 0 }));
  let buffAtk = 0;
  let buffDef = 0;
  let buffCrit = 0;
  let buffParry = 0;
  let killStacks = 0;
  let critStacks = 0; // Pent-Up Wrath
  let risingStacks = 0; // Rising Momentum
  let riposteLeft = 0; // Aggressive Riposte: landed attacks still boosted by the last parry
  let shield = 0; // Blood Curse: overheal kept as a shield
  let poisonLeft = 0; // turns of the crit poison still to tick
  let pending: PendingMods = { damagePct: 0, flat: 0, ignoreDefPct: 0, critPct: 0, crit: false, mult: 1, ignoreParry: false, ignoreDef: false };
  const clearPending = () => {
    pending = { damagePct: 0, flat: 0, ignoreDefPct: 0, critPct: 0, crit: false, mult: 1, ignoreParry: false, ignoreDef: false };
  };
  let damageTaken = 0;
  let healed = 0;
  const critCap = Math.min(p.critCap, 100) / 100;
  const eCrit = Math.max(0, Math.min(e.crit, COMBAT.CRIT_CAP) / 100 - x.enemyCritParryReduction);
  // ResolveAttack scales parry by (1 - passiveParryIgnorePct); it does not subtract it
  const eParry = Math.max(0, (Math.min(e.parry, COMBAT.PARRY_CAP) / 100) * (1 - x.ignoreParryPct) - x.enemyCritParryReduction);
  const heal = (amount: number) => {
    if (p.disableHealing || amount <= 0) return;
    const before = hp;
    if (x.overhealShield && hp + amount > p.maxHp) shield += hp + amount - p.maxHp;
    hp = Math.min(p.maxHp, hp + amount);
    healed += hp - before;
  };
  /** every "Below X% HP" clause we are under, summed (CombatRuntimeEffects.GetBelowHpAggregate) */
  const low = () => belowHpAggregate(x.belowHp, hp, p.maxHp);

  let turn = 0;
  for (; turn < maxTurns; turn++) {
    const u = COMBAT.DMG_MIN + (COMBAT.DMG_MAX - COMBAT.DMG_MIN) * rng();
    const b = low();
    const now = turn * COMBAT.TURN_SECONDS;
    if (turn % 2 === 0) {
      attacks++;
      // Pending mods (a parry's guaranteed crit and the like) are spent by the attack that LANDS,
      // not by the next swing: across 224 archived hits whose armed swing had been parried first,
      // every single one still critted. So a parried swing keeps them for the next.
      const armed = pending;
      clearPending();
      // the counters tick on every attack made, and the bonus lands on the next one
      for (const ev of x.everyNAttacks) {
        if (attacks % ev.n === 0) {
          pending.damagePct += ev.damagePct;
          pending.flat += ev.flat;
          pending.ignoreDefPct = Math.max(pending.ignoreDefPct, ev.ignoreDefPct);
          pending.critPct += ev.critPct;
          if (ev.ignoreParry) pending.ignoreParry = true;
        }
      }
      const opening = x.firstAttack && attacks <= x.firstAttack.hits ? x.firstAttack : null;
      if (!armed.ignoreParry && rng() < eParry) {
        // stopped: what was armed carries over, merged with whatever this swing armed
        pending = mergePending(armed, pending);
      } else {
        const stacked = x.stackingCrit ? Math.min(critStacks * x.stackingCrit.step, x.stackingCrit.max) : 0;
        const critChance = Math.min((p.crit + buffCrit) / 100 + armed.critPct + stacked, critCap);
        const crit = armed.crit || opening?.crit === true || rng() < critChance;
        let mult = dealtMult * armed.mult;
        if (armed.damagePct) mult *= 1 + armed.damagePct;
        if (opening?.damagePct) mult *= 1 + opening.damagePct;
        if (p.executeBelowHpBonus > 0 && enemyHp * 2 < enemyMaxHp) mult *= 1 + p.executeBelowHpBonus;
        if (x.aboveHpDamage && enemyHp > x.aboveHpDamage.abovePct * enemyMaxHp) mult *= 1 + x.aboveHpDamage.bonus;
        if (killStacks) mult *= 1 + killStacks;
        if (x.risingDamage) mult *= 1 + Math.min(risingStacks * x.risingDamage.step, x.risingDamage.max);
        if (riposteLeft > 0) {
          mult *= 1 + x.onParry.damageNextPct;
          riposteLeft--;
        }
        if (b) {
          if (b.atkPct) mult *= 1 + b.atkPct;
          if (b.lifestealPct) mult *= 1; // lifesteal is a heal, handled below
        }
        const firstHitAtk = x.firstHitTaken?.atkPct && hitsTaken > 0 ? 1 + x.firstHitTaken.atkPct : 1;
        const atk = (p.atk + buffAtk + (b?.atkFlat ?? 0) + (b?.allStats ?? 0)) * firstHitAtk;
        const def = armed.ignoreDef ? 0 : Math.max(0, (enemyDef - active(defDebuffs, now)) * (1 - armed.ignoreDefPct));
        const dmg = hitDamage(atk, def, crit, u, mult, p.flatDamagePerHit + armed.flat + (crit ? x.onCritFlat : 0));
        enemyHp -= dmg;
        if (x.enemyMaxHpDamagePct) enemyHp -= enemyMaxHp * x.enemyMaxHpDamagePct;
        if (x.drainPctOfDamageDealt) hp -= Math.round(dmg * x.drainPctOfDamageDealt);
        if (x.executeBelowPct > 0 && enemyHp > 0 && enemyHp < enemyMaxHp * x.executeBelowPct) enemyHp = 0;
        landed++;
        if (x.risingDamage) risingStacks++;
        critStacks = crit ? 0 : critStacks + 1;
        const steal = (p.lifestealPct + (b?.lifestealPct ?? 0) * 100) / 100;
        heal(p.healPerLandedHit + Math.floor(dmg * steal) + (b?.regenPerAttack ?? 0) + (crit ? p.healOnCrit + Math.floor(dmg * x.onCritHealPctOfDamage) : 0));
        if (crit) {
          crits++;
          for (const d of x.onCritDefDebuff) {
            if (d.seconds > 0) defDebuffs.push({ amount: d.amount, until: now + d.seconds });
            else enemyDef = Math.max(0, enemyDef - d.amount);
          }
          if (x.onCritIgnoreDefNext) pending.ignoreDef = true;
          if (x.critPoison) poisonLeft = Math.ceil(x.critPoison.seconds / COMBAT.TURN_SECONDS);
          for (const ev of x.everyNCrits) if (crits % ev.n === 0) pending.mult = Math.max(pending.mult, ev.mult);
        }
        // Sunder Oil: every other landed hit shaves the enemy's DEF, and it stacks all fight
        if (p.sunderPerHit > 0 && landed % 2 === 0) enemyDef = Math.max(0, enemyDef - p.sunderPerHit);
      }
    } else if (rng() < Math.min(p.parry + buffParry, COMBAT.PARRY_CAP) / 100) {
      // parrying negates the blow and can arm the next attack
      const op = x.onParry;
      if (op.critNextPct > 0 && rng() < op.critNextPct) pending.crit = true;
      if (op.damageNextPct) riposteLeft = Math.max(riposteLeft, x.riposteHits || 1);
      if (op.flatNext) pending.flat += op.flatNext;
      if (op.ignoreParryNext) pending.ignoreParry = true;
      if (op.counter) enemyHp -= op.counter;
      if (op.heal) heal(op.heal);
      if (op.defBonus) defBonus += op.defBonus;
      for (const d of x.parryDefBuffs) parryDefs.push({ amount: d.amount, until: now + d.seconds });
    } else {
      hitsTaken++;
      const crit = !b?.immuneCrit && rng() < eCrit;
      const critMult = COMBAT.CRIT_MULT * (1 - p.enemyCritDamageReduction);
      const def = Math.max(0, p.def * (1 + (b?.defPct ?? 0)) + defBonus + buffDef + active(parryDefs, now) + (b?.allStats ?? 0));
      const raw = e.atk * u * (crit ? critMult : 1) * p.damageTakenMult * (COMBAT.DEF_K / (COMBAT.DEF_K + def));
      let dmg = Math.max(1, roundHalfEven(raw));
      // absorbs: the opening hits, then the every-N-hits shield, then the low-HP one
      let absorb = b?.absorbPct ?? 0;
      if (x.firstHitTaken && hitsTaken <= x.firstHitTaken.hits) absorb = Math.max(absorb, x.firstHitTaken.absorbPct);
      if (x.everyNHitsTaken && hitsTaken % x.everyNHitsTaken.n === 0) absorb = Math.max(absorb, x.everyNHitsTaken.absorbPct);
      if (absorb > 0) dmg = Math.max(0, Math.round(dmg * (1 - Math.min(absorb, 1))));
      if (shield > 0) {
        const soaked = Math.min(shield, dmg);
        shield -= soaked;
        dmg -= soaked;
      }
      hp -= dmg;
      damageTaken += dmg;
      if (x.reflectPct && dmg > 0) enemyHp -= Math.max(1, Math.round(dmg * x.reflectPct));
      if (x.firstHitTaken?.counter && hitsTaken === 1) enemyHp -= x.firstHitTaken.counter;
    }
    if (burn) enemyHp -= burn;
    if (poisonLeft > 0 && x.critPoison) {
      enemyHp -= (x.critPoison.damage * COMBAT.TURN_SECONDS) / x.critPoison.seconds;
      poisonLeft--;
    }
    const t = (turn + 1) * COMBAT.TURN_SECONDS;
    for (const r of timers) {
      if (Math.floor(t / r.seconds) > Math.floor((t - COMBAT.TURN_SECONDS) / r.seconds) && (!r.maxStacks || r.stacks < r.maxStacks)) {
        r.stacks++;
        buffAtk += r.atk + r.allStats;
        buffDef += r.def + r.allStats;
        buffCrit += r.allStats;
        buffParry += r.allStats;
      }
    }
    for (const r of p.regenEvery) {
      if (Math.floor(t / r.seconds) > Math.floor((t - COMBAT.TURN_SECONDS) / r.seconds)) heal(r.amount);
    }
    if (b?.regenPerSec && hp > 0) heal(b.regenPerSec * COMBAT.TURN_SECONDS);
    if (enemyHp <= 0 || hp <= 0) break;
  }
  const won = enemyHp <= 0 && hp > 0;
  if (won) {
    if (x.onKillHealPct) heal(Math.round(p.maxHp * x.onKillHealPct));
    if (x.onKillDamageStack) killStacks = Math.min(killStacks + x.onKillDamageStack.pct, x.onKillDamageStack.pct * x.onKillDamageStack.max);
  }
  return { won, turns: turn + 1, endHp: Math.max(0, hp), seconds: (turn + 1) * COMBAT.TURN_SECONDS, damageTaken, healed, dealt: enemyMaxHp - Math.max(0, enemyHp) };
}

export function regenAfterWin(p: PlayerProfile, sectorId: number, regenTable = COMBAT.REGEN_PCT_BY_SECTOR): number {
  const pct = regenTable[sectorId] ?? regenTable[regenTable.length - 1] ?? 0;
  return roundHalfEven(p.maxHp * pct) + p.regenPerFight;
}

// ---- expectations (fast, for the advisor) ----------------------------------------------------

export interface FightExpectation {
  playerHit: number;
  enemyHit: number;
  playerLandRate: number;
  enemyLandRate: number;
  rounds: number;
  damageTakenPerRound: number;
  healPerRound: number;
  netPerRound: number;
  regen: number;
  hpDelta: number;
  seconds: number;
  /** damage over time per round (the crit poison), on top of `playerHit * playerLandRate` */
  dotPerRound: number;
  /**
   * The spread (standard deviation) of the HP the fight costs: the enemy's hits vary (land, crit,
   * the damage roll) and so does the fight's length, since ours vary the same way. With `hpDelta` it
   * gives the chance to survive a fight started at a given HP, which the run needs: a fight lost four
   * times in five has an average cost close to our HP, and counting it as won made a glass cannon
   * look like the best farm in the Cave.
   */
  lossSd: number;
}

/** See lossSd in expectFight. */
const LOSS_SD_SCALE = 1.3;

/** The standard normal's density and distribution (Abramowitz–Stegun 26.2.17, error < 7.5e-8). */
export function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}
export function normCdf(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = normPdf(z) * poly;
  return z >= 0 ? 1 - upper : upper;
}

/**
 * "Every N critical hits: next attack deals ×M", as an average boost per landed hit. Counters with the
 * same N fire on the same crit and the game keeps the larger multiplier (pending.mult = max), so only
 * the best of each N counts; different Ns are taken as independent.
 */
export function critCounterBonus(list: ReadonlyArray<{ n: number; mult: number }>): number {
  const best = new Map<number, number>();
  for (const ev of list) if (ev.n > 0) best.set(ev.n, Math.max(best.get(ev.n) ?? 1, ev.mult));
  let bonus = 0;
  for (const [n, mult] of best) bonus += (mult - 1) / n;
  return bonus;
}

/**
 * The crit poison per round: every landed crit (re)starts it and it ticks each turn while it lasts,
 * so what matters is how often a round goes by with no crit to refresh it.
 */
export function critPoisonPerRound(poison: { damage: number; seconds: number } | null | undefined, critPerRound: number): number {
  if (!poison || poison.seconds <= 0 || critPerRound <= 0) return 0;
  const turns = Math.ceil(poison.seconds / COMBAT.TURN_SECONDS);
  const uptime = 1 - Math.pow(1 - Math.min(1, critPerRound), turns / 2);
  return uptime * 2 * ((poison.damage * COMBAT.TURN_SECONDS) / poison.seconds);
}

/**
 * "Below X% HP: regenerates N HP/sec" over one fight that starts at `hp` and loses `loss` across
 * `seconds`: the HP is taken to fall evenly, the regen pays for the time spent under the line, and it
 * never lifts us back above it (the clause switches off there).
 */
export function lowHpRegen(p: PlayerProfile, hp: number, loss: number, seconds: number): number {
  if (p.disableHealing || loss <= 0 || seconds <= 0) return 0;
  const end = hp - loss;
  // every clause regenerates while we are under its own line (they add up in the game), and none of
  // them lifts us back above it
  let total = 0;
  for (const b of p.procs.belowHp) {
    if (!b.regenPerSec) continue;
    const line = b.pct * p.maxHp;
    total += Math.min(b.regenPerSec * seconds * shareUnder(hp, loss, line), Math.max(0, line - end));
  }
  return total;
}

/** The share of a fight spent under `line`, for HP falling evenly from `hp` by `loss`. */
export function shareUnder(hp: number, loss: number, line: number): number {
  if (hp <= line) return 1;
  if (loss <= 0 || hp - loss >= line) return 0;
  return (line - (hp - loss)) / loss;
}

/**
 * Pent-Up Wrath: every non-crit landed hit adds `step` CRIT, up to `max`, and a crit resets it. The
 * stacks form a small Markov chain; this is its long-run crit rate.
 */
export function stackedCritRate(base: number, stack: { step: number; max: number }, cap: number): number {
  if (stack.step <= 0) return Math.min(base, cap);
  const states = Math.max(1, Math.round(stack.max / stack.step));
  const pc = (s: number) => Math.min(base + Math.min(s * stack.step, stack.max), cap);
  // stationary distribution of "stacks before this hit": s → 0 on a crit, s → min(s+1, top) otherwise
  let pi = new Array<number>(states + 1).fill(1 / (states + 1));
  for (let it = 0; it < 200; it++) {
    const next = new Array<number>(states + 1).fill(0);
    for (let s = 0; s <= states; s++) {
      next[0]! += pi[s]! * pc(s);
      next[Math.min(s + 1, states)]! += pi[s]! * (1 - pc(s));
    }
    pi = next;
  }
  return pi.reduce((a, w, s) => a + w * pc(s), 0);
}

/** Rising Momentum: the average bonus over `landed` hits, +step each, capped, from zero every fight. */
function risingAverage(r: { step: number; max: number } | null, landed: number): number {
  if (!r || r.step <= 0 || landed <= 0) return 0;
  const n = Math.max(1, Math.round(landed));
  const toCap = Math.ceil(r.max / r.step);
  if (n <= toCap) return (r.step * (n - 1)) / 2;
  const ramp = (r.step * toCap * (toCap - 1)) / 2; // hits 0..toCap-1
  return (ramp + r.max * (n - toCap)) / n;
}

/**
 * The average number of stacks a "every `seconds`: +N" timer holds over a fight of `T` seconds,
 * capped at `max` (0: no cap). Stack k is held from k·seconds on.
 */
export function timerAverageStacks(T: number, seconds: number, max: number): number {
  if (T <= 0 || seconds <= 0) return 0;
  const n = Math.floor(T / seconds);
  let area = 0;
  for (let k = 1; k <= n; k++) {
    const held = T - k * seconds; // stack k is on from k·s to the end
    if (!max || k <= max) area += held;
  }
  return area / T;
}

/**
 * How many timed entries (debuffs, buffs) are running on average over a fight of `T` seconds when
 * they arrive at `rate` per second and each lasts `seconds`: it ramps up over the first `seconds`.
 */
function averageRunning(rate: number, seconds: number, T: number): number {
  if (rate <= 0 || seconds <= 0 || T <= 0) return 0;
  return T > seconds ? rate * (seconds - (seconds * seconds) / (2 * T)) : (rate * T) / 2;
}

/**
 * The expected fight, in closed form. It is the ranking proxy for every PvE metric (the route, the
 * per-slot alternatives, the Biblioteca), so it has to see what the items do, not only their stats:
 * every proc the Monte Carlo plays out has an average here. What depends on time — DEF shredded or
 * debuffed by crits, DEF gained on parry, the stat timers, Rising Momentum, the ATK bonus from the
 * first hit taken — takes its average over the fight's length, so the fight is estimated twice: once
 * plain, then with those averages. "Below X% HP" clauses depend on where the run is, so sectorRun
 * blends them in, not this.
 */
export function expectFight(p: PlayerProfile, e: EnemyVariant | SectorEnemy, sectorId: number, regenTable?: number[]): FightExpectation {
  const x = p.procs;
  const op = x.onParry;
  const dealtMult = p.damageDealtMult * elementMultiplier(p.weaponElements, e as SectorEnemy, p.weakBothPct, p.ignoreResist);
  const critCap = Math.min(p.critCap, 100) / 100;
  const secondsPerRound = 2 * COMBAT.TURN_SECONDS;
  // parry and crit on both sides the way ResolveAttack reads them (the Monte Carlo does the same)
  const ignoreParryShare = Math.min(1, x.everyNAttacks.reduce((a, ev) => a + (ev.ignoreParry ? 1 / ev.n : 0), 0));
  const eParry = Math.max(0, (Math.min(e.parry, COMBAT.PARRY_CAP) / 100) * (1 - x.ignoreParryPct) - x.enemyCritParryReduction);
  const playerLandRate = 1 - eParry * (1 - ignoreParryShare);
  const eCrit = Math.max(0, Math.min(e.crit, COMBAT.CRIT_CAP) / 100 - x.enemyCritParryReduction);
  const enemyMaxHp = Math.max(1, e.hp * p.enemyHpMult);
  const baseDef = Math.max(0, e.def * (1 - Math.min(0.75, p.enemyDefIgnorePct + x.ignoreDefPct)));
  // "Every N attacks: …" averages out to 1/N of the attacks
  const procMult = dealtMult * (1 + x.everyNAttacks.reduce((a, ev) => a + ev.damagePct / ev.n, 0));
  const procFlat = p.flatDamagePerHit + x.everyNAttacks.reduce((a, ev) => a + ev.flat / ev.n, 0);
  const defIgnores = x.everyNAttacks.filter((ev) => ev.ignoreDefPct > 0);
  const everyNCrit = x.everyNAttacks.reduce((a, ev) => a + ev.critPct / ev.n, 0);
  const enemyCritMult = COMBAT.CRIT_MULT * (1 - p.enemyCritDamageReduction);
  const timers = x.everyNSec.filter((r) => r.atk || r.def || r.allStats);

  const estimate = (rounds0: number | null) => {
    const T = rounds0 === null ? 0 : rounds0 * secondsPerRound;
    // the stat timers, at their average over the fight
    let tAtk = 0;
    let tDef = 0;
    let tAll = 0;
    for (const r of timers) {
      const k = timerAverageStacks(T, r.seconds, r.maxStacks ?? 0);
      tAtk += k * r.atk;
      tDef += k * r.def;
      tAll += k * r.allStats;
    }
    const enemyLandRate = 1 - Math.min(p.parry + tAll, COMBAT.PARRY_CAP) / 100;
    const parriesPerRound = 1 - enemyLandRate;
    // "+N% ATK for the rest of combat" from the first hit taken: on for all but the opening
    const firstHitAtk = x.firstHitTaken?.atkPct && rounds0 ? 1 + x.firstHitTaken.atkPct * Math.max(0, 1 - 1 / Math.max(1e-6, rounds0 * enemyLandRate)) : 1;
    const atk = (p.atk + tAtk + tAll) * firstHitAtk;

    const natural = Math.min((p.crit + tAll) / 100 + everyNCrit, critCap);
    // each of our attacks follows one of theirs, so a parry arms this many of them
    const armed = parriesPerRound * op.critNextPct;
    const critRate = armed + (1 - armed) * (x.stackingCrit ? stackedCritRate(natural, x.stackingCrit, critCap) : natural);
    const counters = 1 + critRate * critCounterBonus(x.everyNCrits);
    const riposte = op.damageNextPct > 0 ? 1 + Math.min(1, parriesPerRound * (x.riposteHits || 1)) * op.damageNextPct : 1;
    const flatHit = procFlat + critRate * x.onCritFlat + parriesPerRound * op.flatNext;

    // DEF that comes off during the fight: for good (Sunder Oil, crit debuffs with no duration) at
    // half its end value, the timed crit debuffs at how many are running on average
    const landed0 = rounds0 === null ? 0 : rounds0 * playerLandRate;
    const critsPerSec = (playerLandRate * critRate) / secondsPerRound;
    let shredForGood = p.sunderPerHit * (landed0 / 2);
    let timedDown = 0;
    for (const d of x.onCritDefDebuff) {
      if (d.seconds > 0) timedDown += d.amount * averageRunning(critsPerSec, d.seconds, T);
      else shredForGood += d.amount * landed0 * critRate;
    }
    const def = Math.max(0, baseDef - shredForGood / 2 - timedDown);
    const rising = risingAverage(x.risingDamage, landed0);
    const mult = procMult * riposte * (1 + rising);
    const at = (d: number) => expectedHit(atk, d, critRate, mult, flatHit) * counters;
    // "every N attacks ignores X% DEF" and "on crit: next attack ignores DEF" hit a lower DEF
    let hit = at(def);
    const ignoredShare = Math.min(1, defIgnores.reduce((a, ev) => a + 1 / ev.n, 0));
    if (ignoredShare > 0) hit = hit * (1 - ignoredShare) + defIgnores.reduce((a, ev) => a + at(def * (1 - ev.ignoreDefPct)) / ev.n, 0);
    if (x.onCritIgnoreDefNext) hit = hit * (1 - critRate) + at(0) * critRate;

    // our DEF: kept from parries, timed from parries, and the timers
    const parriesPerSec = parriesPerRound / secondsPerRound;
    const parryDefTimed = x.parryDefBuffs.reduce((a, d) => a + d.amount * averageRunning(parriesPerSec, d.seconds, T), 0);
    const defBonus = (op.defBonus * (rounds0 === null ? 0 : rounds0 * parriesPerRound)) / 2 + parryDefTimed + tDef + tAll;
    const enemyHit = expectedHit(e.atk, p.def + defBonus, eCrit, p.damageTakenMult, 0, enemyCritMult);
    const everyNAbsorb = x.everyNHitsTaken ? x.everyNHitsTaken.absorbPct / x.everyNHitsTaken.n : 0;
    const damageTakenPerRound = enemyHit * enemyLandRate * (1 - everyNAbsorb);

    // everything that takes enemy HP each round besides our hit
    const dotPerRound = critPoisonPerRound(x.critPoison, playerLandRate * critRate);
    const burn = p.immolationPctPerTurn > 0 ? 2 * Math.max(1, roundHalfEven(enemyMaxHp * p.immolationPctPerTurn)) : 0;
    const side = dotPerRound + burn + playerLandRate * enemyMaxHp * x.enemyMaxHpDamagePct + damageTakenPerRound * x.reflectPct + parriesPerRound * op.counter;
    const hitPerRound = hit * playerLandRate;

    // the enemy's HP in bands: above X% (bonus), below half (Executioner's), below the execute line
    const opening = x.firstAttack ? x.firstAttack.hits * playerLandRate * ((x.firstAttack.crit ? expectedHit(atk, def, 1, mult, flatHit) * counters - hit : 0) + hit * x.firstAttack.damagePct) : 0;
    const flatStart = opening + (x.firstHitTaken?.counter ?? 0);
    const cuts = new Set([1, 0]);
    if (x.aboveHpDamage) cuts.add(x.aboveHpDamage.abovePct);
    if (p.executeBelowHpBonus > 0) cuts.add(0.5);
    const floor = Math.max(0, x.executeBelowPct);
    cuts.add(floor);
    const edges = [...cuts].filter((c) => c >= floor).sort((a, b) => b - a);
    let rounds = 0;
    let left = flatStart; // HP the opening strikes and counters take off the top
    for (let i = 0; i + 1 < edges.length; i++) {
      const hi = edges[i]!;
      const lo = edges[i + 1]!;
      const mid = (hi + lo) / 2;
      let m = 1;
      if (x.aboveHpDamage && mid > x.aboveHpDamage.abovePct) m *= 1 + x.aboveHpDamage.bonus;
      if (p.executeBelowHpBonus > 0 && mid < 0.5) m *= 1 + p.executeBelowHpBonus;
      let band = (hi - lo) * enemyMaxHp;
      const off = Math.min(band, left);
      band -= off;
      left -= off;
      rounds += band / Math.max(hitPerRound * m + side, 1e-6);
    }

    const timedRegenPerRound = p.regenEvery.reduce((a, r) => a + (r.amount * secondsPerRound) / r.seconds, 0);
    const healPerRound = p.disableHealing
      ? 0
      : playerLandRate * (p.healPerLandedHit + (hit * p.lifestealPct) / 100 + (p.healOnCrit + hit * x.onCritHealPctOfDamage) * critRate) +
        timedRegenPerRound +
        parriesPerRound * op.heal;
    const drainPerRound = hitPerRound * x.drainPctOfDamageDealt;
    // "on first hit taken: absorb X%", once a fight
    const absorbed = x.firstHitTaken ? x.firstHitTaken.absorbPct * enemyHit * Math.min(x.firstHitTaken.hits, rounds * enemyLandRate) : 0;

    // the spread: each side's hit is a crit mixture times the U(0.8, 1.2) roll
    const eu2 = 1 + (COMBAT.DMG_MAX - COMBAT.DMG_MIN) ** 2 / 12;
    const eMix = 1 - eCrit + eCrit * enemyCritMult;
    const eSecond = (enemyHit / eMix) ** 2 * eu2 * (1 - eCrit + eCrit * enemyCritMult * enemyCritMult);
    const varTaken = Math.max(0, enemyLandRate * (1 - everyNAbsorb) * eSecond - damageTakenPerRound ** 2);
    const cm = COMBAT.CRIT_MULT;
    const ourRatio = (eu2 * (1 - critRate + critRate * cm * cm)) / (1 - critRate + critRate * cm) ** 2;
    const varDealt = Math.max(0, playerLandRate * hit * hit * ourRatio - hitPerRound ** 2);
    const dealt = Math.max(1e-6, hitPerRound + side);
    const varRounds = (rounds * varDealt) / (dealt * dealt);
    const net = damageTakenPerRound - (healPerRound - drainPerRound);
    // what the closed form leaves out (the every-N counters, streaks of parries) is about a quarter of
    // the spread: across 7 fights of a Holy build in the Cave the Monte Carlo's was 1.23–1.32× this
    const lossSd = LOSS_SD_SCALE * Math.sqrt(rounds * varTaken + net * net * varRounds);
    return { hit, enemyHit, enemyLandRate, damageTakenPerRound, dotPerRound, rounds, healPerRound: healPerRound - drainPerRound, absorbed, lossSd };
  };

  // again with the fight's length when something builds up with time, until the length settles
  const timeBound =
    timers.length > 0 || x.onCritDefDebuff.length > 0 || x.parryDefBuffs.length > 0 || x.risingDamage !== null || p.sunderPerHit > 0 || op.defBonus > 0 || Boolean(x.firstHitTaken?.atkPct);
  let f = estimate(null);
  for (let pass = 0; timeBound && pass < 3; pass++) {
    const next = estimate(f.rounds);
    const settled = Math.abs(next.rounds - f.rounds) < 0.01 * f.rounds;
    f = next;
    if (settled) break;
  }
  const netPerRound = f.healPerRound - f.damageTakenPerRound;
  const regen = regenAfterWin(p, sectorId, regenTable) + (x.onKillHealPct ? Math.round(p.maxHp * x.onKillHealPct) : 0);
  return {
    playerHit: f.hit,
    enemyHit: f.enemyHit,
    playerLandRate,
    enemyLandRate: f.enemyLandRate,
    rounds: f.rounds,
    damageTakenPerRound: f.damageTakenPerRound,
    healPerRound: f.healPerRound,
    netPerRound,
    regen,
    hpDelta: f.rounds * netPerRound + f.absorbed + regen,
    seconds: f.rounds * secondsPerRound + COMBAT.PAUSE_SECONDS,
    dotPerRound: f.dotPerRound,
    lossSd: f.lossSd,
  };
}

/**
 * "Below X% HP" clauses the fighter is under, added together. CombatRuntimeEffects.GetBelowHpAggregate
 * walks all of them and sums every one whose threshold the HP is under: with "below 30%: +30% DEF"
 * and "below 50%: regenerates 3 HP/sec" on two items, both hold under 30%.
 */
export function belowHpAggregate(list: readonly BelowHp[], hp: number, maxHp: number): BelowHp | undefined {
  let out: BelowHp | undefined;
  for (const b of list) {
    if (!(hp < b.pct * maxHp)) continue;
    if (!out) {
      out = { ...b };
      continue;
    }
    out.atkPct += b.atkPct;
    out.atkFlat += b.atkFlat;
    out.defPct += b.defPct;
    out.allStats += b.allStats;
    out.lifestealPct += b.lifestealPct;
    out.regenPerSec += b.regenPerSec;
    out.regenPerAttack += b.regenPerAttack;
    out.absorbPct += b.absorbPct;
    out.immuneCrit ||= b.immuneCrit;
  }
  return out;
}

/**
 * What a "Below X% HP" clause turns the profile into while it is on (the Monte Carlo reads the same
 * fields turn by turn). Its regen is lowHpRegen's business, so it is left out here.
 */
export function lowHpProfile(p: PlayerProfile, b: BelowHp): PlayerProfile {
  return {
    ...p,
    atk: p.atk + b.atkFlat + b.allStats,
    damageDealtMult: p.damageDealtMult * (1 + b.atkPct),
    def: p.def * (1 + b.defPct) + b.allStats,
    lifestealPct: p.lifestealPct + b.lifestealPct * 100,
    healPerLandedHit: p.healPerLandedHit + b.regenPerAttack,
    damageTakenMult: p.damageTakenMult * (1 - Math.min(1, b.absorbPct)),
    // immune to crits: a crit lands as a normal hit
    enemyCritDamageReduction: b.immuneCrit ? 1 - 1 / COMBAT.CRIT_MULT : p.enemyCritDamageReduction,
    procs: { ...p.procs, belowHp: [] },
  };
}

/** Expected fight against the enemy mix of the whole sector (every index, every roll, weighted). */
export function expectSector(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], regenTable?: number[], playerLevel?: number) {
  let hpDelta = 0;
  let seconds = 0;
  let xp = 0;
  const cache = new Map<SectorEnemy, FightExpectation>();
  const perIndex: number[] = [];
  for (let i = 0; i < sector.totalEnemies; i++) {
    let d = 0;
    for (const r of rosterAt(sector, cats, i)) {
      let ex = cache.get(r.variant);
      if (!ex) cache.set(r.variant, (ex = expectFight(p, r.variant, sector.id, regenTable)));
      d += r.prob * ex.hpDelta;
      seconds += r.prob * ex.seconds;
      xp += r.prob * r.variant.xpBase * (playerLevel === undefined ? 1 : xpMultiplier(playerLevel, r.variant.level, sector.id));
    }
    perIndex.push(d);
    hpDelta += d;
  }
  // expected HP along a clean run from full HP: how low it gets tells how close to dying we are
  let hp = p.maxHp;
  let minHp = hp;
  for (const d of perIndex) {
    hp = Math.min(p.maxHp, hp + d);
    minHp = Math.min(minHp, hp);
  }
  return { avgHpDelta: hpDelta / sector.totalEnemies, perIndex, minHp, secondsPerFight: seconds / sector.totalEnemies, xpPerHour: (xp / seconds) * 3600 };
}

/** DEF at which the expected fight against `e` stops costing HP (regen included). */
export function breakEvenDef(p: PlayerProfile, e: EnemyVariant, sectorId: number, regenTable?: number[]): { def: number | null; alreadyOk: boolean } {
  const at = (def: number) => expectFight({ ...p, def }, e, sectorId, regenTable).hpDelta;
  if (at(p.def) >= 0) {
    let lo = 0;
    let hi = p.def;
    if (at(0) >= 0) return { def: 0, alreadyOk: true };
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) >= 0) hi = mid;
      else lo = mid;
    }
    return { def: hi, alreadyOk: true };
  }
  let lo = p.def;
  let hi = 2000;
  if (at(hi) < 0) return { def: null, alreadyOk: false };
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return { def: hi, alreadyOk: false };
}

// ---- Monte Carlo sector run ------------------------------------------------------------------

export interface SectorSimResult {
  runs: number;
  clearProb: number;
  /** P(still alive after fight i) */
  survival: number[];
  avgEndHp: number;
  avgSeconds: number;
  /** attempts until a clear, restarting from enemy 0 with full HP after each death */
  expectedAttempts: number | null;
  /** how long a lap that clears takes, on average (seconds); null when none cleared */
  clearSeconds: number | null;
  /** with a potion window: the enemy index the potions ran out at, on average over the runs that got that far */
  potionEnd: number | null;
}

/**
 * Potions that last a while, in a lap that can outlast them: `profile` is the build with them on,
 * drunk when the lap reaches enemy `fromIndex` (at once when it starts there or earlier) and good for
 * `seconds` of fighting — a dose is 2 h, and a tank lap of the Cave takes more than 5.
 */
export interface PotionWindow {
  profile: PlayerProfile;
  fromIndex: number;
  seconds: number;
}

export function simulateSector(
  p: PlayerProfile,
  sector: SectorInfo,
  cats: EnemyCategory[],
  opts: { runs: number; startIndex?: number; startHp?: number; seed?: number; regenTable?: number[]; potion?: PotionWindow },
): SectorSimResult {
  const rng = mulberry32(opts.seed ?? 1234567);
  const start = opts.startIndex ?? 0;
  const n = sector.totalEnemies - start;
  const alive = new Array<number>(n).fill(0);
  const pot = opts.potion && opts.potion.seconds > 0 ? opts.potion : null;
  let clears = 0;
  let endHp = 0;
  let seconds = 0;
  let clearSeconds = 0;
  let potionEnds = 0;
  let potionEndSum = 0;
  for (let run = 0; run < opts.runs; run++) {
    let t = 0;
    // with a window: when the potions went down (null: not yet), and whether they have run out
    let drunk: number | null = pot && pot.fromIndex <= start ? 0 : null;
    let over = false;
    let prof = drunk !== null ? pot!.profile : p;
    let hp = Math.min(prof.maxHp, opts.startHp ?? prof.maxHp);
    let dead = false;
    for (let i = 0; i < n; i++) {
      if (pot) {
        if (drunk === null && start + i >= pot.fromIndex) drunk = t;
        const on = drunk !== null && t < drunk + pot.seconds;
        if (drunk !== null && !on && !over) {
          over = true;
          potionEnds++;
          potionEndSum += start + i;
        }
        prof = on ? pot.profile : p;
        hp = Math.min(hp, prof.maxHp);
      }
      const enemy = rollEnemy(sector, cats, start + i, rng);
      const f = simulateFight(prof, hp, enemy, rng);
      t += f.seconds + COMBAT.PAUSE_SECONDS;
      if (!f.won) {
        dead = true;
        break;
      }
      alive[i]!++;
      hp = Math.min(prof.maxHp, f.endHp + regenAfterWin(prof, sector.id, opts.regenTable));
    }
    seconds += t;
    if (!dead) {
      clears++;
      endHp += hp;
      clearSeconds += t;
    }
  }
  const clearProb = clears / opts.runs;
  return {
    runs: opts.runs,
    clearProb,
    survival: alive.map((a) => a / opts.runs),
    avgEndHp: clears ? endHp / clears : 0,
    avgSeconds: seconds / opts.runs,
    expectedAttempts: clearProb > 0 ? 1 / clearProb : null,
    clearSeconds: clears ? clearSeconds / clears : null,
    potionEnd: potionEnds ? potionEndSum / potionEnds : null,
  };
}

/**
 * The farm loop played out: from enemy 0 at full HP, fight until a fight is lost, bank the XP of the
 * wins, start over. What sectorRun estimates in closed form, for its tests and for spot checks.
 */
export function simulateFarm(
  p: PlayerProfile,
  sector: SectorInfo,
  cats: EnemyCategory[],
  /** `maxFights`: stop after the attempt that goes past this many fights (a tank's attempts are long) */
  opts: { attempts: number; maxFights?: number; seed?: number; regenTable?: number[]; playerLevel?: number },
): FarmSimResult {
  const rng = mulberry32(opts.seed ?? 4242);
  let xp = 0;
  let seconds = 0;
  let won = 0;
  let fights = 0;
  let clears = 0;
  let a = 0;
  for (; a < opts.attempts && (opts.maxFights === undefined || fights < opts.maxFights); a++) {
    let hp = p.maxHp;
    let i = 0;
    for (; i < sector.totalEnemies; i++) {
      const enemy = rollEnemy(sector, cats, i, rng);
      const f = simulateFight(p, hp, enemy, rng);
      seconds += f.seconds + COMBAT.PAUSE_SECONDS;
      fights++;
      if (!f.won) break;
      won++;
      xp += enemy.xpBase * (opts.playerLevel === undefined ? 1 : xpMultiplier(opts.playerLevel, enemy.level, sector.id));
      hp = Math.min(p.maxHp, f.endHp + regenAfterWin(p, sector.id, opts.regenTable));
    }
    if (i >= sector.totalEnemies) clears++;
  }
  const n = Math.max(1, a);
  return { attempts: a, xpPerHour: seconds > 0 ? (xp / seconds) * 3600 : 0, xpPerAttempt: xp / n, depth: won / n, clearProb: clears / n, secondsPerAttempt: seconds / n };
}

export interface FarmSimResult {
  /** attempts played (fewer than asked when `maxFights` ran out) */
  attempts: number;
  xpPerHour: number;
  xpPerAttempt: number;
  /** fights won per attempt */
  depth: number;
  clearProb: number;
  secondsPerAttempt: number;
}

export interface EnemyOdds {
  name: string;
  variant: SectorEnemy;
  catIndex: number;
  appearProb: number;
  firstIndex: number;
  lastIndex: number;
  winFull: number;
  avgTurns: number;
  avgHpLost: number;
  /** from full HP, in the Monte Carlo: HP after the fight and the post-win regen, minus the start (−max HP on a loss) */
  hpDelta: number;
  /** enemy HP taken off per round */
  damagePerRound: number;
  expected: FightExpectation;
  breakEven: { def: number | null; alreadyOk: boolean };
}

/** Every enemy the sector can roll, how often it shows up in a lap and where (the ≥1% range). */
function sectorRoster(sector: SectorInfo, cats: EnemyCategory[]) {
  const seen = new Map<SectorEnemy, { name: string; variant: SectorEnemy; catIndex: number; appearProb: number; firstIndex: number; lastIndex: number }>();
  for (let i = 0; i < sector.totalEnemies; i++) {
    for (const r of rosterAt(sector, cats, i)) {
      const o = seen.get(r.variant);
      // the gaussian has long tails: the shown range is where the enemy has at least a 1 % chance
      const likely = r.prob >= 0.01;
      if (o) {
        o.appearProb += r.prob;
        if (likely) {
          if (o.firstIndex < 0) o.firstIndex = i;
          o.lastIndex = i;
        }
      } else {
        seen.set(r.variant, { name: r.category.name, variant: r.variant, catIndex: r.catIndex, appearProb: r.prob, firstIndex: likely ? i : -1, lastIndex: likely ? i : -1 });
      }
    }
  }
  return [...seen.values()].filter((o) => o.firstIndex >= 0);
}

/** `fights` fights from full HP against one enemy, in the Monte Carlo. */
function playEnemy(p: PlayerProfile, e: SectorEnemy, sectorId: number, fights: number, rng: () => number, regenTable?: number[]) {
  let wins = 0;
  let turns = 0;
  let lost = 0;
  let delta = 0;
  let dealt = 0;
  const regen = regenAfterWin(p, sectorId, regenTable);
  for (let k = 0; k < fights; k++) {
    const f = simulateFight(p, p.maxHp, e, rng);
    wins += f.won ? 1 : 0;
    turns += f.turns;
    lost += p.maxHp - f.endHp;
    delta += (f.won ? Math.min(p.maxHp, f.endHp + regen) : 0) - p.maxHp;
    dealt += f.dealt;
  }
  return { winFull: wins / fights, avgTurns: turns / fights, avgHpLost: lost / fights, hpDelta: delta / fights, damagePerRound: turns > 0 ? dealt / turns : 0 };
}

/** Win chance from full HP and cost of every enemy the sector can roll. */
export function enemyOdds(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], opts: { fights: number; seed?: number; regenTable?: number[] }): EnemyOdds[] {
  const rng = mulberry32(opts.seed ?? 7654321);
  return sectorRoster(sector, cats)
    .map((o) => ({
      ...o,
      ...playEnemy(p, o.variant, sector.id, opts.fights, rng, opts.regenTable),
      expected: expectFight(p, o.variant, sector.id, opts.regenTable),
      breakEven: breakEvenDef(p, o.variant, sector.id, opts.regenTable),
    }))
    .sort((a, b) => a.catIndex - b.catIndex || a.variant.level - b.variant.level);
}

/** The sector's average fight in the Monte Carlo alone (what the optimizer plays for damage and survival). */
export function sectorFights(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], opts: { fights: number; seed?: number; regenTable?: number[] }): { damagePerRound: number; hpPerFight: number } {
  const rng = mulberry32(opts.seed ?? 7654321);
  return oddsAverages(sectorRoster(sector, cats).map((o) => ({ appearProb: o.appearProb, ...playEnemy(p, o.variant, sector.id, opts.fights, rng, opts.regenTable) })));
}

/**
 * The sector's average fight, from the Monte Carlo odds: damage per round and HP per fight, each
 * enemy weighted by how often it shows up in a lap.
 */
export function oddsAverages(odds: Array<Pick<EnemyOdds, 'appearProb' | 'damagePerRound' | 'hpDelta'>>): { damagePerRound: number; hpPerFight: number } {
  const total = odds.reduce((a, o) => a + o.appearProb, 0) || 1;
  let damage = 0;
  let hp = 0;
  for (const o of odds) {
    damage += (o.appearProb / total) * o.damagePerRound;
    hp += (o.appearProb / total) * o.hpDelta;
  }
  return { damagePerRound: damage, hpPerFight: hp };
}

// ---- player profile --------------------------------------------------------------------------

export interface PerkMods {
  atkPct?: number;
  defPct?: number;
  maxHpPct?: number;
  damageDealtMult?: number;
  damageTakenMult?: number;
  disableCrit?: boolean;
  bonusDamageFlatPerHit?: number;
  critCap?: number;
  critFlat?: number;
  parryFloor?: number;
  tenacityLifestealPct?: number;
  disableHealing?: boolean;
  flatHealPerHit?: number;
  atkFlat?: number;
  /** Instinctive Guard: DEF gains this fraction per point of PARRY */
  defPctPerParryPoint?: number;
}

/** Item effects that change sustain, parsed the way StatsCalculator does (regex on the effect text). */
/**
 * The item effects that only show up while fighting. The stat ones live in game-math's
 * `synergyBonus`; these are the procs the game keeps in CombatRuntimeEffects (EveryNAttacksEffect,
 * PendingAttackMod, the timed and below-X%-HP regens). Anything not matched here is counted as
 * `ignored`, which is what the UI reports as "fora do cálculo".
 */
export function itemSustain(items: SaveItem[]): Procs {
  return parseProcs(items.flatMap((i) => i.effects));
}

export function buildProfile(
  stats: { hp: number; atk: number; def: number; crit: number; parry: number },
  equipped: SaveItem[],
  mods: PerkMods = {},
  weakBothPct = COMBAT.WEAK_BOTH_PCT,
): PlayerProfile {
  const procs = itemSustain(equipped);
  const weaponElements = equipped.filter((i) => i.slot === 3).map((i) => ELEMENT_NAMES[i.category] ?? 'Nessuna');
  // "Every N sec: regenerates N HP" is the only timer the fight loop needs on its own
  const regenEvery = procs.everyNSec.filter((r) => r.hp > 0).map((r) => ({ seconds: r.seconds, amount: r.hp }));
  // CalcUnconditionalStatPct and CalcAllStatsPerOtherEquippedItem are read by the fight, not by
  // GetTotalStats, so they land here and never in PWR. We add the flat part first and then scale by
  // the percentage; the game computes them in separate passes and the order between the two is our
  // assumption, not something the dump settles.
  const flat = procs.allStatsPerOtherItem * Math.max(0, equipped.length - 1);
  const s = {
    hp: (stats.hp + flat) * (1 + procs.statPct.hp),
    atk: (stats.atk + flat) * (1 + procs.statPct.atk),
    def: (stats.def + flat) * (1 + procs.statPct.def),
    crit: (stats.crit + flat) * (1 + procs.statPct.crit),
    parry: (stats.parry + flat) * (1 + procs.statPct.parry),
  };
  return {
    maxHp: s.hp,
    atk: s.atk + s.hp * procs.hpToAtkPct,
    def: s.def,
    crit: mods.disableCrit ? 0 : s.crit,
    parry: Math.max(s.parry, mods.parryFloor ?? 0),
    critCap: mods.critCap && mods.critCap > 0 ? mods.critCap : COMBAT.CRIT_CAP,
    healPerLandedHit: mods.flatHealPerHit ?? 0,
    lifestealPct: procs.lifestealPct + (mods.tenacityLifestealPct ?? 0) * 100,
    healOnCrit: procs.onCritHeal,
    regenEvery,
    regenPerFight: procs.regenPerFight,
    damageDealtMult: mods.damageDealtMult && mods.damageDealtMult > 0 ? mods.damageDealtMult : 1,
    damageTakenMult: mods.damageTakenMult && mods.damageTakenMult > 0 ? mods.damageTakenMult : 1,
    flatDamagePerHit: mods.bonusDamageFlatPerHit ?? 0,
    enemyCritDamageReduction: procs.enemyCritDamageReduction,
    disableHealing: Boolean(mods.disableHealing),
    weaponElements,
    weakBothPct,
    procs,
    enemyDefIgnorePct: 0,
    enemyHpMult: 1,
    executeBelowHpBonus: 0,
    immolationPctPerTurn: 0,
    sunderPerHit: 0,
    ignoreResist: false,
  };
}

/** The profile after spending extra stat points (perk % multipliers applied like GetTotalStats). */
export function withPoints(p: PlayerProfile, pts: Partial<Record<StatKey, number>>, mods: PerkMods = {}): PlayerProfile {
  const atkMul = 1 + (mods.atkPct ?? 0);
  const defMul = 1 + (mods.defPct ?? 0);
  const hpMul = 1 + (mods.maxHpPct ?? 0);
  return {
    ...p,
    atk: p.atk + (pts.atk ?? 0) * PER_POINT.atk * atkMul,
    def: p.def + (pts.def ?? 0) * PER_POINT.def * defMul,
    maxHp: Math.round(p.maxHp + (pts.hp ?? 0) * PER_POINT.hp * hpMul),
    crit: mods.disableCrit ? 0 : p.crit + (pts.crit ?? 0) * PER_POINT.crit,
    parry: p.parry + (pts.parry ?? 0) * PER_POINT.parry,
  };
}

// ---- advisor ---------------------------------------------------------------------------------

export interface AdvisorOption {
  stat: StatKey;
  points: number;
  avgHpDelta: number;
  minHpFrac: number;
  secondsPerFight: number;
  xpPerHour: number;
}

const SAFE_MARGIN = 0.35;

/** Survive first (expected HP never dips below 35 % in a clean run), then kill faster. */
function score(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], regenTable?: number[]): number {
  const ex = expectSector(p, sector, cats, regenTable);
  const margin = ex.minHp / p.maxHp;
  return margin < SAFE_MARGIN ? margin - 1 + ex.avgHpDelta / 1e4 : ex.xpPerHour / 1e6 + Math.min(margin, 1) * 1e-3;
}

export function adviseOptions(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], points: number, mods: PerkMods = {}, regenTable?: number[]): AdvisorOption[] {
  return STAT_KEYS.map((stat) => {
    const q = withPoints(p, { [stat]: points }, mods);
    const ex = expectSector(q, sector, cats, regenTable);
    return { stat, points, avgHpDelta: ex.avgHpDelta, minHpFrac: ex.minHp / q.maxHp, secondsPerFight: ex.secondsPerFight, xpPerHour: ex.xpPerHour };
  });
}

/** Greedy point-by-point plan: each point goes where it raises the score the most. */
export function advisePlan(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], points: number, mods: PerkMods = {}, regenTable?: number[]) {
  const plan: Record<StatKey, number> = { atk: 0, def: 0, hp: 0, crit: 0, parry: 0 };
  const steps: StatKey[] = [];
  for (let i = 0; i < points; i++) {
    let best: StatKey = 'atk';
    let bestScore = -Infinity;
    for (const stat of STAT_KEYS) {
      const trial = { ...plan, [stat]: plan[stat] + 1 };
      const s = score(withPoints(p, trial, mods), sector, cats, regenTable);
      if (s > bestScore + 1e-12) {
        bestScore = s;
        best = stat;
      }
    }
    plan[best]++;
    steps.push(best);
  }
  const after = withPoints(p, plan, mods);
  return { plan, steps, before: expectSector(p, sector, cats, regenTable), after: expectSector(after, sector, cats, regenTable), profile: after };
}

/**
 * Smallest DEF for which a clean run of the sector, from full HP, never lets the expected HP drop
 * below `marginFrac` of max HP. null = DEF alone cannot get there (the 1-damage floor, or too slow).
 */
export function sectorDefTarget(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], marginFrac: number, regenTable?: number[]): number | null {
  const ok = (def: number) => expectSector({ ...p, def }, sector, cats, regenTable).minHp >= marginFrac * p.maxHp;
  if (ok(0)) return 0;
  let hi = Math.max(p.def, 1);
  while (!ok(hi)) {
    hi *= 2;
    if (hi > 4000) return null;
  }
  let lo = 0;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export const SAFE_MARGIN_FRAC = SAFE_MARGIN;

export interface ElementOption {
  element: ElementName;
  /** average damage multiplier over the sector's enemy mix with one weapon of this element */
  one: number;
  /** ... and with both weapons on it */
  both: number;
  weakShare: number;
  resistShare: number;
}

/** How good each weapon element is for a sector, weighted by how often each enemy shows up. */
export function elementOptions(sector: SectorInfo, cats: EnemyCategory[], weakBothPct = COMBAT.WEAK_BOTH_PCT): ElementOption[] {
  const mix = new Map<SectorEnemy, number>();
  let total = 0;
  for (let i = 0; i < sector.totalEnemies; i++) {
    for (const r of rosterAt(sector, cats, i)) {
      mix.set(r.variant, (mix.get(r.variant) ?? 0) + r.prob);
      total += r.prob;
    }
  }
  return ELEMENT_NAMES.filter((e) => e !== 'Nessuna').map((element) => {
    let one = 0;
    let both = 0;
    let weakShare = 0;
    let resistShare = 0;
    for (const [enemy, weight] of mix) {
      const w = weight / total;
      one += w * elementMultiplier([element], enemy, weakBothPct);
      both += w * elementMultiplier([element, element], enemy, weakBothPct);
      if (enemy.weak === element) weakShare += w;
      else if (enemy.resist === element || enemy.resist2 === element) resistShare += w;
    }
    return { element, one, both, weakShare, resistShare };
  });
}

/** The multiplier the player's current weapons get against the sector's mix. */
export function currentElementMultiplier(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[]): number {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < sector.totalEnemies; i++) {
    for (const r of rosterAt(sector, cats, i)) {
      sum += r.prob * elementMultiplier(p.weaponElements, r.variant, p.weakBothPct);
      total += r.prob;
    }
  }
  return total ? sum / total : 1;
}
