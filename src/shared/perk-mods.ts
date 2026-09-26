/**
 * What each perk does, split the way the game splits it.
 *
 * `stats` is the part StatsCalculator.GetTotalStats applies (PerkModifiers), so it shows up on the
 * character sheet and in PWR. `procs` is the part that only exists inside a fight, in the same shape
 * the item effects use. Together they let the build planner try a loadout the player is not wearing,
 * which the live `GetPerkModifiers` reading cannot do — it only ever reports the equipped set.
 *
 * How the game really builds them (decoded from GameAssembly.dll, spikes/s8_perks.py):
 * - PerkCombat.ApplyPerk is a switch over the perk id writing PerkModifiers. Several numbers go through
 *   PerkEconomy.V(v1, v2), a switch between two balance versions; the game ran version 2 when the
 *   perk texts were captured and when the live tap read the modifiers on 2026-09-23, and every number
 *   below is the v2 one. ApplyPerk applies each id at most once (a `1 << id` bitmask).
 * - Perks 6, 7, 8, 11, 19, 23, 25, 28 and 31 do nothing in ApplyPerk: their mechanic is a *combat
 *   text* (PerkData.combatEffect) that StatsCalculator.ForEachEquippedEffect feeds through the very
 *   same parsers as item effects. Mirror Echo feeds the left neighbour's combat text a second time —
 *   which is all it can copy. So those perks are parsed from their combat text here too, and the
 *   live tap replaces these texts with the game's own when it can (setLivePerkTexts).
 */
import { parseProcs, type Procs } from './item-effects';
import type { PerkStatMods } from './game-math';
import type { PerkMods } from './combat';

export interface PerkEffect {
  /** applied by GetTotalStats, so it changes the sheet and PWR */
  stats?: PerkStatMods;
  /** applied inside the fight (PerkCombat.GetPerkModifiers) */
  combat?: PerkMods;
  /** the fight-only mechanics, in the item-effect shape */
  procs?: Partial<Procs>;
  /** true when we know the perk matters but do not simulate it */
  partial?: string;
}

export const PERK_EFFECTS: Record<number, PerkEffect> = {
  // 1 Pent-Up Wrath: each non-crit hit stacks +10 % CRIT (max +50 %), reset on a crit
  1: { procs: { stackingCrit: { step: 0.1, max: 0.5 } } },
  // 2 Innate Guard: PARRY floor of 15 %
  2: { combat: { parryFloor: 15 } },
  // 3 First Blood: the first attack of a fight always crits
  3: { procs: { firstAttack: { crit: true, damagePct: 0, hits: 1 } } },
  // 4 Brute's Temper: 20 % of DEF becomes ATK
  4: { stats: { defToAtkPct: 0.2 } },
  // 5 Rising Momentum: +4 % damage per landed attack, up to +40 %
  5: { procs: { risingDamage: { step: 0.04, max: 0.4 } } },
  // 9 Bottled Lightning
  9: { stats: { atkPct: 0.4, maxHpPct: -0.15 }, combat: { atkPct: 0.4, maxHpPct: -0.15 } },
  // 10 Dragonhide
  10: { stats: { defPct: 0.35, maxHpPct: 0.15, atkPct: -0.12 }, combat: { defPct: 0.35, maxHpPct: 0.15, atkPct: -0.12 } },
  // 12 Crimson Vow
  12: { combat: { flatHealPerHit: 3 } },
  // 13 Reckless Abandon
  13: { combat: { damageDealtMult: 1.3, damageTakenMult: 1.1 } },
  // 14 Rival's Calling: PvP only
  14: { partial: 'só vale no PvP' },
  // 15 Aggression
  15: { stats: { atkFlat: 6 }, combat: { atkFlat: 6 } },
  // 16 Guardian Angel: a shield when the fight starts below half HP
  16: { partial: 'escudo ao entrar abaixo de 50% de vida' },
  // 17 Colossus Hunter:每 hit also takes ~1.5 % of the enemy's max HP
  17: { procs: { enemyMaxHpDamagePct: 0.015 } },
  // 18 Tenacity
  18: { combat: { tenacityLifestealPct: 0.05 } },
  // 20 Absolute Precision: no crits, +20 flat damage
  20: { combat: { disableCrit: true, bonusDamageFlatPerHit: 20 } },
  // 21 Burning Heart: no healing at all, +50 % damage
  21: { combat: { disableHealing: true, damageDealtMult: 1.5 } },
  // 22 Duelist's Gamble
  22: { combat: { damageDealtMult: 2, damageTakenMult: 1.25 } },
  // 23 Blood Curse: lifestealFlat += V(0.15, 0.13), drainPctOfDamageDealt += V(0, 0.11) and, v1 only,
  // 1% of max HP lost per turn. The overheal shield is its combat text.
  23: { combat: { tenacityLifestealPct: 0.13 }, procs: { drainPctOfDamageDealt: 0.11 } },
  // 24 Coup de Grace: execute below 20 % (PvE)
  24: { procs: { executeBelowPct: 0.2 } },
  // 26 Mirror Echo: copies the perk to its left
  // 26 Mirror Echo: copies the triggered mechanic of the perk in the slot to its left. Handled in
  // mergePerkProcs, which sees the slot order; next to a stat-only perk it does nothing. KISA ran it
  // behind Thorns and reflected 100% of every hit (564 of 564).
  26: {},
  // 27 Critical Apex
  27: { combat: { critFlat: 15, critCap: 75 }, stats: { critFlat: 15 } },
  // 29 Last Breath: survive a killing blow once per fight
  29: { partial: 'uma vez por luta, sobrevive com 25% da vida' },
  // 30 Instinctive Guard: +0.5 % DEF per point of PARRY, capped at +27.5 %
  30: { stats: { defPctPerParryPoint: 0.005 }, combat: { defPctPerParryPoint: 0.005 } },
};

/** The stat half of a loadout, in the order GetTotalStats applies it. */
export function mergePerkStats(ids: number[]): PerkStatMods {
  const out: PerkStatMods = {};
  for (const id of ids) {
    const s = PERK_EFFECTS[id]?.stats;
    if (!s) continue;
    for (const [k, v] of Object.entries(s) as Array<[keyof PerkStatMods, number]>) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** The fight half: the numbers PerkCombat.GetPerkModifiers would report for this loadout. */
export function mergePerkCombat(ids: number[]): PerkMods {
  const out: PerkMods = {};
  for (const id of ids) {
    const c = PERK_EFFECTS[id]?.combat;
    if (!c) continue;
    for (const [key, v] of Object.entries(c)) {
      const k = key as keyof PerkMods;
      if (typeof v === 'boolean') {
        if (v) (out[k] as boolean) = true;
      } else if (k === 'damageDealtMult' || k === 'damageTakenMult') {
        (out[k] as number) = ((out[k] as number | undefined) ?? 1) * v;
      } else if (k === 'critCap' || k === 'parryFloor') {
        (out[k] as number) = Math.max((out[k] as number | undefined) ?? 0, v);
      } else {
        (out[k] as number) = ((out[k] as number | undefined) ?? 0) + v;
      }
    }
  }
  return out;
}

/** Perks the planner cannot simulate, so the UI can say so instead of quietly ignoring them. */
export function partialPerks(ids: number[]): Array<{ id: number; why: string }> {
  return ids.flatMap((id) => {
    const why = PERK_EFFECTS[id]?.partial;
    return why ? [{ id, why }] : [];
  });
}

/** The fight mechanics of a loadout, in the item-effect shape so they merge with the gear's. */
const MIRROR_ECHO = 26;

/**
 * PerkData.combatEffect for the perks whose mechanic is text, in balance version 2 (PerkEconomy's
 * table in GameAssembly.dll). Where the description and the combat text disagree, the combat text is
 * what the fight uses: Bulwark says "heal 4 HP per second" and regenerates 8.
 */
export const PERK_COMBAT_TEXT_V2: Readonly<Record<number, string>> = {
  6: 'Every 3 attacks: +140% damage and ignores parry',
  7: 'Critical hits apply a poison dealing 28 damage over 4 sec',
  8: 'On parry: next 2 attacks have +35% damage',
  11: 'Below 40% HP: +80% ATK',
  19: 'Reflects 50% of damage taken',
  23: 'healing above max HP becomes a temporary shield',
  25: 'Every 5 attacks: +120% damage and ignores parry',
  28: 'Below 25% HP: absorb 42% damage and regenerates 8 HP',
  // not in the v2 table, so its text is the base catalog's; out of ApplyPerk's range (ids 1–30)
  31: 'Your attacks ignore 35% of enemy PARRY and 35% of enemy DEF',
};

let liveTexts: Record<number, string> | null = null;

/**
 * The game's own combat texts, read by the live tap from PerkCatalog.All. They win over the table
 * above: they follow a balance-version flip and they cover perks this build has never seen.
 */
export function setLivePerkTexts(texts: Record<number, string> | null | undefined): void {
  liveTexts = texts && Object.keys(texts).length ? { ...texts } : null;
}

/** The combat text a perk feeds into the fight, if it has one. */
export function perkCombatText(id: number): string | undefined {
  const live = liveTexts?.[id];
  if (live !== undefined) return live || undefined;
  return PERK_COMBAT_TEXT_V2[id];
}

/**
 * The combat texts an equipped loadout feeds into the fight, in the game's order: every perk's own,
 * then Mirror Echo's copy of its left neighbour's (ForEachEquippedEffect).
 */
export function loadoutCombatTexts(ids: number[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const t = perkCombatText(id);
    if (t) out.push(t);
  }
  const echo = ids.indexOf(MIRROR_ECHO);
  if (echo > 0) {
    const t = perkCombatText(ids[echo - 1]!);
    if (t) out.push(t);
  }
  return out;
}

/**
 * The slot orders worth trying for a set of perks: order only matters for Mirror Echo, which copies
 * the combat text of the perk to its left. Its copy pays next to the perks whose text adds up
 * (Heavy Lunge, Aggressive Riposte, Dying Fury, Thorns, Voracious Echo, Bulwark, Armor Piercer);
 * next to Lingering Venom or Blood Curse, or anything else, it does nothing.
 */
export function perkLoadoutOrders(set: number[]): number[][] {
  if (!set.includes(MIRROR_ECHO)) return [set];
  const others = set.filter((id) => id !== MIRROR_ECHO);
  const worth = others.filter((id) => ECHO_PAYS.has(id) && perkCombatText(id));
  if (!worth.length) return [[...others, MIRROR_ECHO]];
  return worth.map((t) => [...others.filter((id) => id !== t), t, MIRROR_ECHO]);
}
const ECHO_PAYS = new Set([6, 8, 11, 19, 25, 28, 31]);

export function mergePerkProcs(ids: number[]): Partial<Procs> {
  // what the combat texts do, parsed exactly like item effects
  const out: Partial<Procs> = { ...parseProcs(loadoutCombatTexts(ids)) };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    // Mirror Echo copies text only; ApplyPerk-based mechanics apply once whatever it copies
    if (id === MIRROR_ECHO) continue;
    const p = PERK_EFFECTS[id]?.procs;
    if (!p) continue;
    out.everyNAttacks = [...(out.everyNAttacks ?? []), ...(p.everyNAttacks ?? [])];
    out.belowHp = [...(out.belowHp ?? []), ...(p.belowHp ?? [])];
    for (const k of ['reflectPct', 'ignoreParryPct', 'ignoreDefPct', 'enemyMaxHpDamagePct', 'executeBelowPct', 'drainPctOfDamageDealt'] as const) {
      if (p[k]) out[k] = (out[k] ?? 0) + p[k]!;
    }
    if (p.critPoison) out.critPoison = p.critPoison;
    if (p.firstAttack) out.firstAttack = p.firstAttack;
    if (p.stackingCrit) out.stackingCrit = p.stackingCrit;
    if (p.risingDamage) out.risingDamage = p.risingDamage;
    if (p.onParry) {
      const prev = out.onParry ?? { counter: 0, heal: 0, defBonus: 0, critNextPct: 0, damageNextPct: 0, reflectPct: 0, flatNext: 0, ignoreParryNext: false };
      out.onParry = {
        counter: prev.counter + p.onParry.counter,
        heal: prev.heal + p.onParry.heal,
        defBonus: prev.defBonus + p.onParry.defBonus,
        critNextPct: Math.max(prev.critNextPct, p.onParry.critNextPct),
        damageNextPct: Math.max(prev.damageNextPct, p.onParry.damageNextPct),
        reflectPct: prev.reflectPct + p.onParry.reflectPct,
        flatNext: prev.flatNext + p.onParry.flatNext,
        ignoreParryNext: prev.ignoreParryNext || p.onParry.ignoreParryNext,
      };
    }
  }
  return out;
}

export type PerkModelKind = 'modifiers' | 'text' | 'partial' | 'unknown';

/**
 * How well the model knows a perk: its numbers come from ApplyPerk ('modifiers'), from its combat
 * text ('text'), only partly ('partial'), or not at all ('unknown') — a perk this build has never
 * seen, e.g. one added by a game update, which then counts as doing nothing.
 */
export function perkModelStatus(id: number): { kind: PerkModelKind; text?: string; why?: string } {
  const effect = PERK_EFFECTS[id];
  const text = perkCombatText(id);
  if (effect?.partial) return { kind: 'partial', why: effect.partial, ...(text ? { text } : {}) };
  if (text) return { kind: 'text', text };
  if (effect) return { kind: 'modifiers' };
  return { kind: 'unknown' };
}
