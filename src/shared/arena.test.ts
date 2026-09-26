/**
 * The Arena against what the game showed: the wave-1 enemies the live tap read (2026-09-25), the
 * wave bosses of the designer's QA table (Sim/ArenaBossQA), and the checkpoint rule.
 */
import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import { arenaBoss, arenaBossPending, arenaCheckpoint, arenaRoster, arenaScales, simulateArena, type ArenaWorld } from './arena';
import { buildProfile, type EnemyCategory, type PlayerProfile, type SectorInfo } from './combat';

const WORLD: ArenaWorld = { sectors: sectors as unknown as SectorInfo[], cats: enemies as unknown as EnemyCategory[] };

describe('the enemies of a wave', () => {
  it('wave 1 matches the live tap: HP ×2.1792, ATK ×2.096, level +1, no resistances', () => {
    const roster = arenaRoster(WORLD, 1);
    const find = (name: string, color: string) => roster.find((e) => e.name === name && e.color === color)!;
    expect(find('Black Orc', 'Viola')).toMatchObject({ hp: 9748, level: 41, def: 38.9133, crit: 16.32, parry: 6, resist: 'Nessuna', resist2: 'Nessuna' });
    expect(find('Black Orc', 'Viola').atk).toBeCloseTo(70.753, 2);
    expect(find('Ogre', 'Blu')).toMatchObject({ hp: 21384, level: 45 });
    expect(find('Ogre', 'Blu').atk).toBeCloseTo(84.93, 2);
    expect(find('Butcher', 'Viola')).toMatchObject({ hp: 18532, level: 47 });
    expect(find('Butcher', 'Viola').atk).toBeCloseTo(105.416, 2);
    expect(find('Black Orc', 'Viola').dropChance).toBe(0.15);
    expect(find('Ogre', 'Blu').dropChance).toBe(0.09);
  });

  it('never Grigio; the chances add up; War Camp at wave 1, the Cave from wave 50', () => {
    for (const w of [1, 7, 25, 49, 50, 80]) {
      const roster = arenaRoster(WORLD, w);
      expect(roster.every((e) => e.color !== 'Grigio')).toBe(true);
      expect(roster.reduce((a, e) => a + e.prob, 0)).toBeCloseTo(1, 9);
    }
    expect(new Set(arenaRoster(WORLD, 1).map((e) => e.sector))).toEqual(new Set([4]));
    expect(new Set(arenaRoster(WORLD, 50).map((e) => e.sector))).toEqual(new Set([6]));
    // wave 1: 70% Blu
    expect(arenaRoster(WORLD, 1).filter((e) => e.color === 'Blu').reduce((a, e) => a + e.prob, 0)).toBeCloseTo(0.7, 9);
    expect(arenaScales(10).hp).toBeCloseTo(3.495, 3);
    expect(arenaScales(40).atk).toBeCloseTo(6.425, 3);
  });

  it('the four wave bosses match the QA table', () => {
    const b = (w: number) => arenaBoss(WORLD, w)!;
    expect(b(10)).toMatchObject({ hp: 68536, def: 71.3, crit: 6.7, parry: 16.2, resist: 'Frost', weak: 'Flame', boss: 0 });
    expect(b(10).atk).toBeCloseTo(584.35, 1);
    expect(b(20).hp).toBe(105402);
    expect(b(20).atk).toBeCloseTo(791.19, 1);
    expect(b(30).hp).toBe(386178);
    expect(b(30).atk).toBeCloseTo(1888.05, 1);
    expect(b(40)).toMatchObject({ hp: 524690, resist: 'Flame', weak: 'Frost', boss: 3 });
    expect(b(40).atk).toBeCloseTo(2414.07, 1);
    expect(arenaBoss(WORLD, 15)).toBeNull();
    // once per save: beaten bosses do not come back at wave 50+
    expect(arenaBossPending(0, 10)).toBe(true);
    expect(arenaBossPending(0b1111, 50)).toBe(false);
  });

  it('a death goes back to the last multiple of 5 below the wave', () => {
    expect([12, 10, 5, 4, 1, 26].map(arenaCheckpoint)).toEqual([10, 5, 1, 1, 1, 25]);
  });
});

describe('hours in the Arena', () => {
  const hero = (atk: number, def: number, hp: number): PlayerProfile => buildProfile({ hp, atk, def, crit: 20, parry: 20 }, []);

  it('a stronger build climbs further in the same hours, and the record never goes down', () => {
    const start = { wave: 1, kills: 0, hp: null, record: 0, bossMask: 0 };
    const weak = simulateArena(hero(120, 120, 1500), WORLD, start, { runs: 40, hours: 2, seed: 3 });
    const strong = simulateArena(hero(400, 250, 4000), WORLD, start, { runs: 40, hours: 2, seed: 3 });
    expect(strong.best).toBeGreaterThan(weak.best);
    expect(strong.record).toBeGreaterThanOrEqual(weak.record);
    for (let i = 1; i < strong.reach.length; i++) expect(strong.reach[i]!).toBeLessThanOrEqual(strong.reach[i - 1]! + 1e-9);
    expect(strong.winsPerHour).toBeGreaterThan(0);
    expect(strong.itemsPerHour).toBeGreaterThan(0);
    const rarity = strong.rarityPerHour.reduce((a, v) => a + v, 0);
    expect(rarity).toBeCloseTo(strong.itemsPerHour, 6);
  });

  it('a build that cannot win dies and goes back, and never passes its wave', () => {
    const r = simulateArena(hero(5, 0, 50), WORLD, { wave: 12, kills: 3, hp: null, record: 11, bossMask: 0 }, { runs: 10, hours: 0.5, seed: 1 });
    expect(r.deathsPerHour).toBeGreaterThan(0);
    expect(r.record).toBe(11);
    expect(r.reach[0]).toBe(0);
  });
});
