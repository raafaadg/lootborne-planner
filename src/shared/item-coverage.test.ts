/**
 * Every effect string in the game has to be claimed by one of the three layers, or an item is being
 * scored as if it did nothing. This is the regression net for a game update: a new effect shape
 * shows up here as a failure with the text in the message.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProcs } from './item-effects';
import { synergyBonus } from './game-math';
import type { CatalogItem, SaveItem } from './contracts';

const CAT: CatalogItem[] = JSON.parse(readFileSync('game-data/items.json', 'utf8'));
const NEUTRAL = JSON.stringify(parseProcs([]));
/** Drops, currency and stamina: real effects, but none of them touch a fight. */
const ECONOMY = /Bloodmarks|drop chance|bonus item chance|Stamina|Vigor/i;

function fake(effect: string): SaveItem {
  return {
    uid: 1, templateId: 1, itemName: 'x', slot: 0, rarity: 0, category: 1,
    hp: 0, atk: 0, def: 0, crit: 0, parry: 0, effects: [effect],
    isNew: false, locked: false, isBossExclusive: false, grantSource: 0,
  };
}

function layerOf(effect: string): 'synergy' | 'proc' | 'economy' | null {
  if (synergyBonus([fake(effect)]).modelled > 0) return 'synergy';
  if (JSON.stringify(parseProcs([effect])) !== NEUTRAL) return 'proc';
  if (ECONOMY.test(effect)) return 'economy';
  return null;
}

describe('item effect coverage', () => {
  const all = [...new Set(CAT.flatMap((i) => i.effects))];

  it('claims every effect string in the catalog', () => {
    const orphans = all.filter((e) => layerOf(e) === null);
    expect(orphans, `sem modelo:\n${orphans.join('\n')}`).toEqual([]);
  });

  it('covers the whole catalog', () => {
    expect(CAT).toHaveLength(424);
    expect(all.length).toBe(336);
  });

  it('reads the clauses ApplyCrossSynergyBonuses falls through to', () => {
    // a named item, which the game matches with ^If equipped with ([^:]+): against equippedItemNames
    const pair = [
      { ...fake('If equipped with Everfrost Sword: +8 ATK, +3% CRIT'), uid: 1 },
      { ...fake(''), uid: 2, itemName: 'Everfrost Sword', effects: [] },
    ];
    expect(synergyBonus(pair).bonus.atk).toBe(8);
    expect(synergyBonus(pair).bonus.crit).toBeCloseTo(3);
    // without the partner it pays nothing
    expect(synergyBonus([pair[0]!]).bonus.atk).toBe(0);
  });

  it('splits a named clause on " or "', () => {
    const base = fake('If equipped with Death Scythe or Voidblade: +9 ATK, +6% CRIT');
    const withVoid = [base, { ...fake(''), uid: 2, itemName: 'Voidblade', effects: [] }];
    expect(synergyBonus(withVoid).bonus.atk).toBe(9);
  });

  it('pays the element-category clause once per distinct element worn', () => {
    const wearer = { ...fake('For every different element category equipped: +2% CRIT, +2 ATK'), uid: 1, category: 1 };
    const two = [wearer, { ...fake(''), uid: 2, category: 2, effects: [] }];
    const three = [...two, { ...fake(''), uid: 3, category: 3, effects: [] }];
    expect(synergyBonus(two).bonus.atk).toBe(4); // Arcane + Flame
    expect(synergyBonus(three).bonus.atk).toBe(6); // + Frost
  });

  it('keeps the unconditional percentages out of the stat layer and in the fight', () => {
    // GetTotalStats never applies these, so synergyBonus must not either
    expect(synergyBonus([fake('+25% DEF and +10% HP')]).bonus.def).toBe(0);
    const p = parseProcs(['+25% DEF and +10% HP', '+18% ATK, -10% DEF']);
    expect(p.statPct.def).toBeCloseTo(0.15); // +25% and -10%
    expect(p.statPct.hp).toBeCloseTo(0.1);
    expect(p.statPct.atk).toBeCloseTo(0.18);
  });

  it('reads "+N to all stats for every other equipped item"', () => {
    expect(parseProcs(['+1 to all stats for every other equipped item']).allStatsPerOtherItem).toBe(1);
  });
});
