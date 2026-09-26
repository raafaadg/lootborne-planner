import { describe, expect, it } from 'vitest';
import items from '../../game-data/items.json';
import { PVP_BOSSES } from './battles';
import { COMBAT, buildProfile, elementMultiplier } from './combat';
import type { CatalogItem } from './contracts';
import { forPvp } from './duel';
import { catalogAsItem } from './plan-eval';
import { BOSS_LOADOUTS, bossForLevel, bossModel } from './pvp-boss';
import { pvpWinRate, runsFor } from './pvp-optimizer';

const CATALOG = items as CatalogItem[];
const byName = (n: string) => CATALOG.find((c) => c.name === n)!;
const AGNI = PVP_BOSSES[3]!;

describe('bossModel', () => {
  it('fights with the stats the game gave it and the loadout BuildLoadout(3) hands out', () => {
    const m = bossModel(AGNI);
    expect(m.profile.maxHp).toBe(1805);
    expect(m.profile.atk).toBeCloseTo(65.2);
    expect(m.perkIds).toEqual([]); // pvpEquippedPerkIds is never filled
    expect(m.elements).toEqual({ resist: 'Flame', weak: 'Frost' });
    for (const [, name] of BOSS_LOADOUTS[3]!) expect(byName(name)).toBeTruthy();
  });

  it('is the boss of the level band', () => {
    expect(bossForLevel(4)).toBeNull();
    expect(bossForLevel(24)?.name).toBe("Nero d'Inferno");
    expect(bossForLevel(53)?.name).toBe('Agni Pariksha');
  });
});

describe('elements in a boss fight (ResolveAttack: !isPvP || isBossPvp)', () => {
  it('cuts two Flame weapons to 70% and doubles up for two Frost ones', () => {
    expect(elementMultiplier(['Flame', 'Flame'], { resist: 'Flame', weak: 'Frost' })).toBeCloseTo(1 - 2 * COMBAT.ELEMENT_PCT);
    expect(elementMultiplier(['Frost', 'Frost'], { resist: 'Flame', weak: 'Frost' })).toBeCloseTo(1 + COMBAT.WEAK_BOTH_PCT);
  });

  it('keeps the weapons aside through forPvp, where the arena applies them per opponent', () => {
    const p = buildProfile({ hp: 500, atk: 150, def: 90, crit: 25, parry: 35 }, [catalogAsItem(byName('Flaming Axe'), 3)]);
    const pvp = forPvp(p, []);
    expect(pvp.weaponElements).toEqual([]);
    expect(pvp.elementWeapons).toEqual(['Flame']);
  });

  it('makes the same stats win more often with Frost weapons than with Flame ones', () => {
    const stats = { hp: 520, atk: 260, def: 95, crit: 30, parry: 37 };
    const flame = buildProfile(stats, [catalogAsItem(byName('Flaming Axe'), 3), catalogAsItem(byName('Flaming Axe'), 4)]);
    const frost = { ...flame, weaponElements: ['Frost', 'Frost'] as typeof flame.weaponElements };
    const pool = [bossModel(AGNI)];
    const runs = runsFor(pool, 8);
    expect(pvpWinRate(frost, [], pool, runs)).toBeGreaterThan(pvpWinRate(flame, [], pool, runs) + 0.1);
  });
});

describe('runsFor', () => {
  it('gives one boss as many fights as the 16-opponent arena', () => {
    expect(runsFor(new Array(16), 8)).toBe(8);
    expect(runsFor([1], 8)).toBe(128);
  });
});
