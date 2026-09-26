/**
 * Potions that run out mid-lap. A dose lasts 2 h and a tank lap of the Cave takes more than 5, so a
 * clear chance with the potions on for the whole lap was a promise the game does not keep.
 */
import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import consumables from '../../game-data/consumables.json';
import { buildProfile, sectorCategories, simulateSector, type EnemyCategory, type SectorInfo } from './combat';
import { mergeMods, withConsumables, type Consumable } from './consumables';

const SECTOR = (sectors as unknown as SectorInfo[])[1]!;
const CATS = sectorCategories(SECTOR, enemies as unknown as EnemyCategory[]);
const POTS = consumables as unknown as Consumable[];
const bastionRampart = mergeMods([1, 3].map((id) => POTS.find((c) => c.id === id)!.mods));
// a build that needs the potions to get through the Village: 0.3% without them, 100% with
const base = buildProfile({ hp: 550, atk: 40, def: 25, crit: 15, parry: 15 }, []);
const potted = withConsumables(base, bastionRampart);
const sim = (potion?: { fromIndex: number; seconds: number }) =>
  simulateSector(potion ? base : potted, SECTOR, CATS, { runs: 600, seed: 5, ...(potion ? { potion: { profile: potted, ...potion } } : {}) });

describe('potions in a window of the lap', () => {
  const none = simulateSector(base, SECTOR, CATS, { runs: 600, seed: 5 });
  const always = sim();

  it('is the same lap as potions all the way when the window outlasts it', () => {
    const long = sim({ fromIndex: 0, seconds: 1e9 });
    expect(long.clearProb).toBe(always.clearProb);
    expect(long.survival).toEqual(always.survival);
    expect(long.potionEnd).toBeNull();
  });

  it('lands between no potions and potions all the way when it runs out', () => {
    expect(always.clearProb).toBeGreaterThan(none.clearProb);
    const lapSeconds = always.clearSeconds ?? always.avgSeconds;
    const short = sim({ fromIndex: 0, seconds: lapSeconds / 3 });
    expect(short.clearProb).toBeLessThan(always.clearProb);
    expect(short.survival.reduce((a, v) => a + v, 0)).toBeGreaterThanOrEqual(none.survival.reduce((a, v) => a + v, 0) - 0.5);
    // they run out somewhere inside the lap
    expect(short.potionEnd).not.toBeNull();
    expect(short.potionEnd!).toBeGreaterThan(0);
    expect(short.potionEnd!).toBeLessThan(SECTOR.totalEnemies);
  });

  it('starts at the enemy they are drunk at', () => {
    const late = sim({ fromIndex: 30, seconds: 600 });
    if (late.potionEnd !== null) expect(late.potionEnd).toBeGreaterThan(30);
    // the first 30 fights are the plain build's (the same odds; the dice drift once a run drinks)
    const early = simulateSector(base, SECTOR, CATS, { runs: 600, seed: 5 });
    for (let i = 0; i < 29; i++) expect(Math.abs(late.survival[i]! - early.survival[i]!)).toBeLessThan(0.07);
  });

  it('times the laps that clear', () => {
    if (always.clearProb > 0) expect(always.clearSeconds).toBeGreaterThan(SECTOR.totalEnemies * 3);
    else expect(always.clearSeconds).toBeNull();
  });
});
