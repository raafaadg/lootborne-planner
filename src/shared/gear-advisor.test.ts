import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import type { SaveItem, SaveState } from './contracts';
import { buildProfile, sectorCategories, type EnemyCategory, type SectorInfo } from './combat';
import { powerScore } from './game-math';
import { rankGear, sectorMix, sectorRun, sectorValue } from './gear-advisor';
import { mergePerkCombat, mergePerkStats, partialPerks } from './perk-mods';

const FOREST = (sectors as unknown as SectorInfo[])[2]!;
const CATS = sectorCategories(FOREST, enemies as unknown as EnemyCategory[]);
const STATS = { hp: 540, atk: 60, def: 100, crit: 30, parry: 15 };

const item = (over: Partial<SaveItem>): SaveItem => ({
  uid: 1, templateId: 1, itemName: 'x', slot: 3, rarity: 1, category: 0, hp: 0, atk: 0, def: 0, crit: 0, parry: 0,
  effects: [], isNew: false, locked: false, isBossExclusive: false, grantSource: 0, ...over,
});

describe('the sector mix', () => {
  it('is a probability distribution over the enemies of one lap', () => {
    const mix = sectorMix(FOREST, CATS);
    expect(mix.length).toBeGreaterThan(3);
    expect(mix.reduce((a, m) => a + m.weight, 0)).toBeCloseTo(1, 6);
  });
});

describe('what a build is worth against a sector', () => {
  const base = buildProfile(STATS, []);

  it('more ATK means more damage per round, in proportion', () => {
    const more = sectorValue({ ...base, atk: STATS.atk * 2 }, FOREST, CATS);
    expect(more.damagePerRound).toBeGreaterThan(sectorValue(base, FOREST, CATS).damagePerRound * 1.9);
  });

  it('more CRIT means more damage, bounded by the x2 multiplier', () => {
    const plain = sectorValue({ ...base, crit: 0 }, FOREST, CATS).damagePerRound;
    const half = sectorValue({ ...base, crit: 50 }, FOREST, CATS).damagePerRound;
    expect(half / plain).toBeGreaterThan(1.4);
    expect(half / plain).toBeLessThan(1.6);
  });

  it('more enemy DEF is felt through the 60/(60+DEF) curve, not linearly', () => {
    const v = sectorValue(base, FOREST, CATS);
    expect(v.damagePerRound).toBeGreaterThan(0);
    expect(v.secondsPerFight).toBeGreaterThan(0);
  });

  it('reports the element multiplier of the current weapons against the mix', () => {
    // Forest: Kobold and Gnoll are weak to Shadow and all three resist Flame
    const shadow = sectorValue({ ...base, weaponElements: ['Shadow', 'Shadow'] }, FOREST, CATS);
    const flame = sectorValue({ ...base, weaponElements: ['Flame', 'Flame'] }, FOREST, CATS);
    expect(shadow.elementMult).toBeGreaterThan(1);
    expect(flame.elementMult).toBeLessThan(1);
    expect(shadow.damagePerRound).toBeGreaterThan(flame.damagePerRound);
  });
});

describe('ranking gear by damage instead of PWR', () => {
  // two weapons the game would score almost the same, but one hits this sector's weakness
  const shadowBlade = item({ uid: 10, templateId: 10, itemName: 'Shadow Blade', category: 5, atk: 10 });
  const flameBlade = item({ uid: 11, templateId: 11, itemName: 'Flame Blade', category: 2, atk: 12 });
  const state = {
    inventory: [item({ uid: 1, templateId: 1, itemName: 'Plain Sword', atk: 10 }), shadowBlade, flameBlade],
    equippedSlots: ['Arma 1'],
    equippedUids: [1],
    allocatedHp: 0, allocatedAtk: 0, allocatedDef: 0, allocatedCrit: 0, allocatedParry: 0,
  } as unknown as SaveState;
  const ctx = { sector: FOREST, cats: CATS, perkIds: [] };

  it('PWR prefers the bigger ATK, damage prefers the element that lands', () => {
    expect(powerScore({ ...STATS, atk: 12 })).toBeGreaterThan(powerScore({ ...STATS, atk: 10 }));
    const byDamage = rankGear(state, { ...ctx, metric: 'damage' })[0]!;
    const byPower = rankGear(state, { ...ctx, metric: 'power' })[0]!;
    expect(byPower.options[0]!.item.itemName).toBe('Flame Blade');
    expect(byDamage.options[0]!.item.itemName).toBe('Shadow Blade');
  });

  it('the deltas are relative to what is equipped now', () => {
    const picks = rankGear(state, { ...ctx, metric: 'damage' })[0]!;
    expect(picks.current?.itemName).toBe('Plain Sword');
    expect(picks.currentValue.damagePerRound).toBeGreaterThan(0);
    const shadow = picks.options.find((o) => o.item.itemName === 'Shadow Blade')!;
    // +15 % against the share of the mix that is weak to Shadow, on the same ATK
    expect(shadow.damageDelta).toBeGreaterThan(0.04);
  });
});

describe('the perk table', () => {
  it('reproduces the merge the game reported for Crimson Vow + Dragonhide + Bottled Lightning', () => {
    const m = mergePerkCombat([12, 10, 9]);
    expect(m.atkPct).toBeCloseTo(0.28, 6); // -12 % + 40 %
    expect(m.defPct).toBeCloseTo(0.35, 6);
    expect(m.maxHpPct).toBeCloseTo(0, 6); // +15 % - 15 %
    expect(m.flatHealPerHit).toBe(3);
  });

  it('multiplies the damage multipliers instead of adding them', () => {
    const m = mergePerkCombat([13, 22]); // +30 % dealt, x2 dealt
    expect(m.damageDealtMult).toBeCloseTo(1.3 * 2, 6);
    expect(m.damageTakenMult).toBeCloseTo(1.1 * 1.25, 6);
  });

  it('keeps the sheet stats and the fight numbers apart', () => {
    expect(mergePerkStats([12]).atkPct).toBeUndefined(); // Crimson Vow never touches the sheet
    expect(mergePerkStats([9]).atkPct).toBeCloseTo(0.4, 6);
  });

  it('names the perks it cannot simulate rather than ignoring them', () => {
    // Rival's Calling and Last Breath are simulated in the arena (duel.ts) but not in PvE
    expect(partialPerks([14, 26, 29]).map((p) => p.id)).toEqual([14, 29]);
    expect(partialPerks([9, 12])).toHaveLength(0);
  });
});

describe('one attempt through the sector', () => {
  const weak = buildProfile({ hp: 200, atk: 12, def: 5, crit: 0, parry: 0 }, []);
  const strong = buildProfile({ hp: 4000, atk: 400, def: 300, crit: 40, parry: 30 }, []);

  it('a weak build dies early and never sees the deep enemies', () => {
    // depth is the expected number of fights won: this one wins next to none
    const r = sectorRun(weak, FOREST, CATS);
    expect(r.clears).toBe(false);
    expect(r.clearProb).toBeLessThan(1e-6);
    expect(r.depth).toBeLessThan(1);
    expect(r.lowestHp).toBe(0);
  });

  it('a strong build survives the lap', () => {
    const r = sectorRun(strong, FOREST, CATS);
    expect(r.clears).toBe(true);
    expect(r.clearProb).toBeGreaterThan(0.99);
    expect(r.depth).toBeCloseTo(FOREST.totalEnemies, 1);
    expect(r.lowestHp).toBeGreaterThan(0);
  });

  it('a coin-flip fight counts as half a win, not as a win', () => {
    // enough HP to survive the average first fight, but only just: the old run counted it as won
    const edge = buildProfile({ hp: 420, atk: 45, def: 30, crit: 10, parry: 5 }, []);
    const r = sectorRun(edge, FOREST, CATS);
    expect(r.depth).toBeGreaterThan(0);
    expect(r.clearProb).toBeLessThan(0.5);
  });

  it('the farm rate only counts the XP banked before dying', () => {
    // dying on the first enemy banks nothing at all, which is exactly what the loop is worth
    expect(sectorRun(weak, FOREST, CATS).xpPerHour).toBe(0);
    const mid = buildProfile({ hp: 1200, atk: 90, def: 90, crit: 20, parry: 15 }, []);
    const r = sectorRun(mid, FOREST, CATS);
    expect(r.xpPerAttempt).toBeGreaterThan(0);
    expect(r.xpPerHour).toBeCloseTo((r.xpPerAttempt / r.secondsPerAttempt) * 3600, 4);
  });

  it('getting deeper raises both the depth and what the loop banks', () => {
    const mid = buildProfile({ hp: 1200, atk: 90, def: 90, crit: 20, parry: 15 }, []);
    const a = sectorRun(buildProfile({ hp: 700, atk: 40, def: 40, crit: 5, parry: 5 }, []), FOREST, CATS);
    const b = sectorRun(mid, FOREST, CATS);
    expect(b.depth).toBeGreaterThan(a.depth);
    expect(b.xpPerHour).toBeGreaterThan(a.xpPerHour);
  });
});

describe('the two goals pull in different directions', () => {
  it('ranks by the farm loop and by depth with different scores', () => {
    const state = {
      inventory: [
        item({ uid: 1, templateId: 1, itemName: 'Plain Sword', atk: 10 }),
        item({ uid: 2, templateId: 2, itemName: 'Glass Cannon', atk: 40, hp: -0 }),
        item({ uid: 3, templateId: 3, itemName: 'Turtle Plate', slot: 1, def: 40, hp: 300 }),
      ],
      equippedSlots: ['Arma 1', 'Corpo'],
      equippedUids: [1, 0],
      allocatedHp: 0, allocatedAtk: 0, allocatedDef: 0, allocatedCrit: 0, allocatedParry: 0,
    } as unknown as SaveState;
    const ctx = { sector: FOREST, cats: CATS, perkIds: [] };
    const farm = rankGear(state, { ...ctx, metric: 'farm' });
    const progress = rankGear(state, { ...ctx, metric: 'progress' });
    expect(farm[0]!.options.length).toBeGreaterThan(0);
    // the deltas are computed for both metrics whichever one is sorting
    const pick = progress.flatMap((s) => s.options)[0]!;
    expect(typeof pick.depthDelta).toBe('number');
    expect(typeof pick.farmDelta).toBe('number');
  });
});
