import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SaveItem, SaveState } from './contracts';
import { BASE_STATS, applyPerkStats, estimateBuild, parseStatList, powerScore, synergyBonus, upgradeCandidates } from './game-math';

const item = (over: Partial<SaveItem>): SaveItem => ({
  uid: 1, templateId: 1, itemName: 'Thing', slot: 0, rarity: 0, category: 0, hp: 0, atk: 0, def: 0, crit: 0, parry: 0,
  effects: [], isNew: false, locked: false, isBossExclusive: false, grantSource: 1, ...over,
});

describe('powerScore (StatsCalculator.GetPowerScore)', () => {
  it('base stats alone', () => {
    // 0.8*400 + 9*8 + 6*5 + 6*5 + 8*3 = 320 + 72 + 30 + 30 + 24
    expect(powerScore(BASE_STATS)).toBe(476);
  });

  it('matches the in-game stats card (LV 4: HP 436, ATK 19.2, DEF 10, CRIT 11.4, PARRY 5.7 -> 695)', () => {
    expect(powerScore({ hp: 436, atk: 19.2, def: 10, crit: 11.4, parry: 5.7 })).toBe(695);
  });

  it('caps CRIT at 60 and PARRY at 55 for scoring', () => {
    const capped = powerScore({ hp: 0, atk: 0, def: 0, crit: 60, parry: 55 });
    expect(powerScore({ hp: 0, atk: 0, def: 0, crit: 90, parry: 80 })).toBe(capped);
  });
});

describe('synergies', () => {
  it('parses stat lists with % and "and"', () => {
    expect(parseStatList('+0.8% CRIT and +1.3 ATK')).toEqual({ crit: 0.8, atk: 1.3 });
    expect(parseStatList('+1 ATK, +2 HP')).toEqual({ atk: 1, hp: 2 });
  });

  it('"For every other <element> item" pays count-1 times the text, times 1.3, truncated', () => {
    const flame = (uid: number, effects: string[] = []) => item({ uid, category: 2, effects });
    const { bonus } = synergyBonus([flame(1, ['For every other Flame item: +3 ATK']), flame(2), flame(3), item({ uid: 4, category: 3 })]);
    expect(bonus.atk).toBe(Math.trunc(2 * 3 * 1.3)); // 7.8 -> 7
  });

  it('reproduces the Adept Rod seen in the running game (4 Arcane items: +5 ATK, +3.12 CRIT)', () => {
    const arcane = (uid: number, effects: string[] = []) => item({ uid, category: 1, effects });
    const rod = ['For every other Arcane item: +0.8% CRIT and +1.3 ATK'];
    const { bonus } = synergyBonus([arcane(1, rod), arcane(2), arcane(3), arcane(4)]);
    expect(bonus.atk).toBe(5); // trunc(3 * 1.3 * 1.3) = trunc(5.07)
    expect(bonus.crit).toBeCloseTo(3.12, 5); // 3 * 0.8 * 1.3, not truncated
  });

  it('a cross-element bonus is worth exactly what the text says', () => {
    const src = item({ uid: 1, category: 3, effects: ['If equipped with an Arcane item: +4 ATK, +3% CRIT'] });
    const { bonus } = synergyBonus([src, item({ uid: 2, category: 1 })]);
    expect(bonus).toMatchObject({ atk: 4, crit: 3 });
  });

  it('"If equipped with a Frost item" needs another Frost item', () => {
    const src = item({ uid: 1, category: 2, effects: ['If equipped with a Frost item: +1 ATK, +2 HP'] });
    expect(synergyBonus([src]).bonus.hp).toBe(0);
    expect(synergyBonus([src, item({ uid: 2, category: 3 })]).bonus).toMatchObject({ atk: 1, hp: 2 });
  });

  it('procs are counted as ignored, not modelled', () => {
    const r = synergyBonus([item({ effects: ['Below 40% HP: +10% ATK'] })]);
    expect(r.ignored).toBe(1);
    expect(r.modelled).toBe(0);
  });
});

describe('estimateBuild on a real save', () => {
  const state = JSON.parse(
    JSON.parse(readFileSync(join(__dirname, '../../fixtures/saves/level-up.after.json'), 'utf8')).payload,
  ) as SaveState;

  it('adds base, equipped items and allocated points', () => {
    const b = estimateBuild(state);
    expect(b.stats.hp).toBeGreaterThan(BASE_STATS.hp);
    expect(b.allocated.atk).toBeCloseTo(state.allocatedAtk * 0.2);
    expect(b.power).toBe(powerScore(b.stats));
  });

  it('upgrade candidates never include equipped items and are sorted by gain', () => {
    const ups = upgradeCandidates(state);
    const equipped = new Set(state.equippedUids);
    expect(ups.every((u) => !equipped.has(u.item.uid))).toBe(true);
    for (let i = 1; i < ups.length; i++) expect(ups[i - 1]!.powerDelta).toBeGreaterThanOrEqual(ups[i]!.powerDelta);
  });
});

/**
 * The exact build the running game reported on 2026-09-22: equipment, 115 points and the perks
 * Crimson Vow + Dragonhide + Pent-Up Wrath. GetTotalStats said 543 / 42.328 / 102.465 / 30.64 / 13.5
 * and the stats card said PWR 1886.
 */
describe('a build measured against the running game', () => {
  const eq = (over: Partial<SaveItem>) => item(over);
  const items: SaveItem[] = [
    eq({ uid: 1, category: 3, hp: 19, def: 5, parry: 3, effects: ['If equipped with an Arcane item: +4 ATK, +3% CRIT'] }),
    eq({ uid: 2, category: 1, hp: 21, def: 3, crit: 0.5, parry: 0.5, effects: ['If equipped with a Frost item: +1 ATK, +2 HP'] }),
    eq({ uid: 3, category: 1, hp: 12, atk: 0.5, def: 2.1, crit: 0.6, parry: 1, effects: ['If equipped with an Arcane item: +4 ATK, +3% CRIT'] }),
    eq({ uid: 4, category: 1, slot: 3, hp: 4, atk: 4.3, def: 0.9, crit: 1.4, parry: 0.5, effects: ['For every other Arcane item: +0.8% CRIT and +1.3 ATK'] }),
    eq({ uid: 5, category: 1, slot: 3, hp: 4, atk: 4.3, def: 0.9, crit: 1.4, parry: 0.5, effects: ['For every other Arcane item: +0.8% CRIT and +1.3 ATK'] }),
    eq({ uid: 6, category: 3, hp: 10, def: 3, parry: 4, effects: ['Reduces Stamina consumption by 5%'] }),
    eq({ uid: 7, category: 5, atk: 1, crit: 4, parry: 1, effects: ['If equipped with an Arcane item: +4% CRIT, +3 ATK'] }),
  ];
  const state = {
    inventory: items,
    equippedSlots: ['Testa', 'Corpo', 'Cintura', 'Arma 1', 'Arma 2', 'Anello 1', 'Trinket'],
    equippedUids: [1, 2, 3, 4, 5, 6, 7],
    allocatedHp: 0, allocatedAtk: 40, allocatedDef: 70, allocatedCrit: 5, allocatedParry: 0,
  } as unknown as SaveState;
  // PerkCombat.GetPerkModifiers for Dragonhide (+35% DEF, +15% max HP, -12% ATK)
  const mods = { atkPct: -0.12, defPct: 0.35, maxHpPct: 0.15 };
  const weight = 60 + 55 + 50; // Crimson Vow + Dragonhide + Pent-Up Wrath psWeight

  it('lands on the five numbers GetTotalStats returned', () => {
    const b = estimateBuild(state, undefined, { mods, weight });
    expect(b.beforePerks.atk).toBeCloseTo(48.1, 4);
    expect(b.stats.hp).toBe(543);
    expect(b.stats.atk).toBeCloseTo(42.328, 3);
    expect(b.stats.def).toBeCloseTo(102.465, 3);
    expect(b.stats.crit).toBeCloseTo(30.64, 4);
    expect(b.stats.parry).toBeCloseTo(13.5, 4);
  });

  it('lands on the PWR the stats card showed', () => {
    expect(estimateBuild(state, undefined, { mods, weight }).power).toBe(1886);
  });

  it('without the perks it is the old, too-low number', () => {
    expect(estimateBuild(state).power).toBeLessThan(1886);
  });

  it('applies the perk block in GetTotalStats order', () => {
    // DEF feeds ATK before the ATK multiplier, and parry can feed DEF
    const s = { hp: 100, atk: 10, def: 50, crit: 0, parry: 20 };
    expect(applyPerkStats(s, { defToAtkPct: 0.5, atkPct: 1 }).atk).toBeCloseTo((10 + 25) * 2, 4);
    expect(applyPerkStats(s, { defPctPerParryPoint: 0.01 }).def).toBeCloseTo(50 * 1.2, 4);
    expect(applyPerkStats(s, { maxHpPct: 0.15 }).hp).toBe(115);
  });
});
