import { describe, expect, it } from 'vitest';
import data from '../../game-data/consumables.json';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import { buildProfile, expectFight, mulberry32, sectorCategories, sectorEnemy, simulateFight, type EnemyCategory, type SectorInfo } from './combat';
import { ARMOR_PEN_CAP, affectsCombat, mergeMods, withConsumables, type Consumable } from './consumables';

const CONSUMABLES = data as Consumable[];
const byId = (id: number) => CONSUMABLES.find((c) => c.id === id)!;
const FOREST = (sectors as unknown as SectorInfo[])[2]!;
const KOBOLD = sectorEnemy(sectorCategories(FOREST, enemies as unknown as EnemyCategory[]).find((c) => c.name === 'Kobold')!, 'Blu');
const P = buildProfile({ hp: 543, atk: 42.3, def: 102.5, crit: 30.6, parry: 13.5 }, [], { flatHealPerHit: 3 });

describe('the catalog read from the game', () => {
  it('has every potion with its decoded numbers', () => {
    expect(CONSUMABLES.length).toBeGreaterThanOrEqual(21);
    for (const c of CONSUMABLES) {
      expect(c.id).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.effect.length).toBeGreaterThan(0);
    }
  });

  it('Feline Reflexes is the +16 PARRY one the game reported live', () => {
    expect(byId(6).mods.parryFlat).toBe(16);
    expect(byId(6).durationSec).toBe(7200);
  });

  it('the Elixirs are instant and change nothing in a fight', () => {
    expect(byId(29).durationSec).toBe(0);
    expect(affectsCombat(byId(29).mods)).toBe(false);
    expect(affectsCombat(byId(6).mods)).toBe(true);
  });

  it('loot potions are flagged as outside the fight', () => {
    expect(affectsCombat(byId(15).mods)).toBe(false); // Wisdom, +20% XP
    expect(affectsCombat(byId(16).mods)).toBe(false); // Collector's Eye
  });
});

describe('applying potions to a build', () => {
  it('percentages land on the final stats', () => {
    const p = withConsumables(P, mergeMods([byId(2).mods, byId(3).mods, byId(4).mods, byId(5).mods, byId(6).mods]));
    expect(p.atk).toBeCloseTo(42.3 * 1.25, 4); // Fury
    expect(p.def).toBeCloseTo(102.5 * 1.3, 4); // Rampart
    expect(p.maxHp).toBe(Math.round(543 * 1.2)); // Vigor
    expect(p.crit).toBeCloseTo(30.6 + 20, 4); // Savagery
    expect(p.parry).toBeCloseTo(13.5 + 16, 4); // Feline Reflexes
  });

  it('stacks the additive ones and multiplies the multipliers', () => {
    const m = mergeMods([{ atkPct: 0.25 }, { atkPct: 0.1 }, { damageTakenMult: 0.8 }, { damageTakenMult: 0.5 }]);
    expect(m.atkPct).toBeCloseTo(0.35, 6);
    expect(m.damageTakenMult).toBeCloseTo(0.4, 6);
  });

  it('armour penetration cannot go past the 75 % the game caps it at', () => {
    const p = withConsumables(P, mergeMods([byId(10).mods, byId(10).mods, byId(10).mods]));
    expect(p.enemyDefIgnorePct).toBe(ARMOR_PEN_CAP);
  });

  it('Regeneration adds its share of max HP to what a win gives back', () => {
    const p = withConsumables(P, byId(7).mods);
    expect(p.regenPerFight).toBe(Math.round(543 * 0.18));
  });
});

describe('potions in a simulated fight', () => {
  const rng = () => mulberry32(3);
  it('Armor Breaker makes our hits land harder', () => {
    const plain = simulateFight(P, P.maxHp, KOBOLD, rng());
    const pen = withConsumables(P, byId(10).mods);
    const fast = simulateFight(pen, pen.maxHp, KOBOLD, rng());
    expect(fast.turns).toBeLessThan(plain.turns);
  });

  it('Attrition takes 15 % off the enemy HP bar', () => {
    const p = withConsumables(P, byId(13).mods);
    expect(expectFight(p, KOBOLD, 2).rounds).toBeCloseTo(expectFight(P, KOBOLD, 2).rounds * 0.85, 1);
  });

  it('Piercer drops the penalty of a resisted weapon', () => {
    const flame = { ...P, weaponElements: ['Flame' as const, 'Flame' as const] };
    const piercer = withConsumables(flame, byId(28).mods);
    expect(expectFight(piercer, KOBOLD, 2).playerHit).toBeGreaterThan(expectFight(flame, KOBOLD, 2).playerHit);
  });

  it('Immolation burns the enemy down even while we are parried', () => {
    const p = withConsumables(P, byId(27).mods);
    expect(simulateFight(p, p.maxHp, KOBOLD, rng()).turns).toBeLessThanOrEqual(simulateFight(P, P.maxHp, KOBOLD, rng()).turns);
  });

  it('a potion that only touches loot leaves the fight identical', () => {
    const p = withConsumables(P, byId(15).mods);
    expect(simulateFight(p, p.maxHp, KOBOLD, rng())).toEqual(simulateFight(P, P.maxHp, KOBOLD, rng()));
  });
});
