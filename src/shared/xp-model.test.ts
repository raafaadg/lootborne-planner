/**
 * The XP side of the farm model, checked against the game: the level curve (XPSystem), the sector's
 * intended level in the over-level penalty (ScaleXPForSector), the fast fight model against the Monte
 * Carlo for a crit-counter build, and the level-cap ETA.
 */
import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import type { BattleRow } from './battles';
import {
  buildProfile,
  critCounterBonus,
  critPoisonPerRound,
  expectFight,
  lowHpRegen,
  mulberry32,
  sectorCategories,
  sectorEnemy,
  sectorIntendedLevel,
  simulateFight,
  xpMultiplier,
  type EnemyCategory,
  type PlayerProfile,
  type SectorInfo,
} from './combat';
import { MAX_LEVEL, xpBaseAtLevel, xpNeededForNextLevel, xpToLevel } from './game-math';
import { levelEta, sectorPayAt } from './level-eta';

const CATS = enemies as unknown as EnemyCategory[];
const GORGE = (sectors as unknown as SectorInfo[])[5]!;
const gorge = sectorCategories(GORGE, CATS);
const deserter = gorge.find((c) => c.name === 'Deserter')!;
const grigio = sectorEnemy(deserter, 'Grigio');

describe('the level curve (XPSystem)', () => {
  it('is exact on the anchors', () => {
    // XPNeededForNextLevel(L) = (int)(XpBaseAtLevel(L) × 45)
    expect(xpNeededForNextLevel(53)).toBe(66338 * 45);
    expect(xpNeededForNextLevel(56)).toBe(73254 * 45);
    expect(xpNeededForNextLevel(59)).toBe(80465 * 45);
  });

  it('is geometric between anchors', () => {
    const b = xpBaseAtLevel(55);
    expect(b).toBeCloseTo(66338 * Math.pow(73254 / 66338, 2 / 3), 0);
    // what a PvP win paid at level 55, and a loss (a quarter)
    expect(Math.trunc(b)).toBe(70872);
    expect(Math.trunc(Math.fround(b * 0.25))).toBe(17718);
  });

  it('grows every level and stops at the cap', () => {
    for (let l = 1; l < MAX_LEVEL - 1; l++) expect(xpNeededForNextLevel(l + 1)).toBeGreaterThanOrEqual(xpNeededForNextLevel(l));
    expect(MAX_LEVEL).toBe(60);
    expect(xpNeededForNextLevel(60)).toBe(Infinity);
  });

  it('adds up the bars left to the cap', () => {
    const rest = [56, 57, 58, 59].reduce((a, l) => a + xpNeededForNextLevel(l), 0);
    expect(xpToLevel(55, 1_000_000)).toBe(xpNeededForNextLevel(55) - 1_000_000 + rest);
    // the live tap's figure for the current bar wins over ours
    expect(xpToLevel(55, 1_000_000, 60, 3_189_000)).toBe(2_189_000 + rest);
    expect(xpToLevel(60, 0)).toBe(0);
  });
});

describe('the over-level penalty counts from the sector', () => {
  it("uses the sector's intended level when the enemy is below it", () => {
    expect(sectorIntendedLevel(5)).toBe(47);
    expect(sectorIntendedLevel(9)).toBe(56); // clamped like the game
    // recorded at level 55 in Sector 5: the level-43 and the level-47 Deserter both pay 40%
    expect(Math.trunc(31154 * xpMultiplier(55, 43, 5))).toBe(12461);
    expect(Math.trunc(36562 * xpMultiplier(55, 47, 5))).toBe(14624);
    // counting from the enemy alone would have paid nothing
    expect(xpMultiplier(55, 43)).toBe(0);
  });

  it('lets an enemy above the intended level pay more', () => {
    expect(xpMultiplier(58, 55, 5)).toBe(1);
    expect(xpMultiplier(58, 47, 5)).toBeCloseTo(0.04, 6);
  });

  it('fades a sector we have outgrown', () => {
    expect([55, 56, 57, 58, 59].map((l) => Number(sectorPayAt(5, l).toFixed(2)))).toEqual([0.4, 0.28, 0.16, 0.04, 0]);
    expect(sectorPayAt(6, 59)).toBe(1);
  });
});

describe('the fast fight model and the item counters', () => {
  it('averages "every N crits: next attack ×M", keeping the best of each N', () => {
    expect(critCounterBonus([])).toBe(0);
    expect(critCounterBonus([{ n: 3, mult: 3 }])).toBeCloseTo(2 / 3, 9);
    // two counters of 3 fire on the same crit and the game keeps the larger
    expect(critCounterBonus([{ n: 3, mult: 3 }, { n: 3, mult: 2 }])).toBeCloseTo(2 / 3, 9);
    expect(critCounterBonus([{ n: 3, mult: 3 }, { n: 4, mult: 2 }])).toBeCloseTo(2 / 3 + 1 / 4, 9);
  });

  it('keeps the crit poison up when crits are frequent', () => {
    const full = 2 * ((28 * 0.4) / 4); // two ticks a round
    expect(critPoisonPerRound({ damage: 28, seconds: 4 }, 0.52)).toBeGreaterThan(0.95 * full);
    expect(critPoisonPerRound({ damage: 28, seconds: 4 }, 0.05)).toBeLessThan(0.3 * full);
    expect(critPoisonPerRound(null, 0.5)).toBe(0);
  });

  it('pays the low-HP regen only under the line, and never lifts us over it', () => {
    const p = { ...buildProfile({ hp: 400, atk: 50, def: 20, crit: 10, parry: 10 }, []) };
    p.procs = { ...p.procs, belowHp: [{ pct: 0.5, atkPct: 0, atkFlat: 0, defPct: 0, allStats: 0, lifestealPct: 0, regenPerSec: 3, regenPerAttack: 0, absorbPct: 0, immuneCrit: false }] };
    expect(lowHpRegen(p, 400, 100, 16)).toBe(0); // ends at 300, above 200
    expect(lowHpRegen(p, 150, 100, 16)).toBeCloseTo(48, 6); // all of it under the line
    expect(lowHpRegen(p, 250, 100, 16)).toBeCloseTo(24, 6); // half of the fall is under 200
    expect(lowHpRegen(p, 190, 10, 60)).toBeCloseTo(20, 6); // capped: back to the line, not beyond
  });

  it('agrees with the Monte Carlo on a crit-counter build (our Flame farm build)', () => {
    // the equipped build at level 55: parry arms a certain crit, two "every 3 crits" counters, the
    // crit poison, "every 4 attacks +30%", and regen under half HP
    const base = buildProfile({ hp: 467, atk: 227, def: 90.5, crit: 28.6, parry: 38.3 }, [], { flatHealPerHit: 3 });
    const p: PlayerProfile = {
      ...base,
      damageDealtMult: 1.3,
      damageTakenMult: 1.1,
      procs: {
        ...base.procs,
        everyNAttacks: [{ n: 4, damagePct: 0.3, flat: 0, ignoreDefPct: 0, critPct: 0 }],
        everyNCrits: [{ n: 3, mult: 3 }, { n: 3, mult: 2 }],
        critPoison: { damage: 28, seconds: 4 },
        onParry: { ...base.procs.onParry, critNextPct: 1 },
        belowHp: [{ pct: 0.5, atkPct: 0, atkFlat: 0, defPct: 0, allStats: 0, lifestealPct: 0, regenPerSec: 3, regenPerAttack: 0, absorbPct: 0, immuneCrit: false }],
      },
    };
    const rng = mulberry32(11);
    let turns = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) turns += simulateFight(p, p.maxHp, grigio, rng).turns;
    const mcRounds = turns / n / 2;
    const ex = expectFight(p, grigio, 5);
    // 116 recorded fights against this enemy averaged 18.8 of our attacks
    expect(Math.abs(ex.rounds - mcRounds) / mcRounds).toBeLessThan(0.08);
    // without the counters the fast model had these fights a third longer
    const plain = expectFight({ ...p, procs: { ...p.procs, everyNCrits: [], critPoison: null } }, grigio, 5);
    expect(plain.rounds / mcRounds).toBeGreaterThan(1.25);
  });
});

describe('the ETA to the level cap', () => {
  const T0 = Date.parse('2026-09-23T23:00:00Z');
  let seq = 0;
  const row = (min: number, patch: Partial<BattleRow>): BattleRow => ({
    id: String(seq++),
    t: new Date(T0 + min * 60_000).toISOString(),
    mode: 'pve',
    modeFrom: 'live',
    won: true,
    xp: 0,
    enemy: 'Deserter',
    enemyColor: 'Grigio',
    enemyLevel: 43,
    sector: 5,
    enemyIndex: 1,
    hp: [400, 350],
    stamina: [50, 49],
    pity: 0,
    durationMs: 20_000,
    durationFrom: 'live',
    turns: 38,
    drops: [],
    died: false,
    source: 'save',
    ...patch,
  });
  // an hour of the Sector 5 farm at level 55: 100 Deserter kills at 40% and 5 PvP wins
  const hour = [
    ...Array.from({ length: 100 }, (_, i) => row(i * 0.6, { xp: 12461 })),
    ...Array.from({ length: 5 }, (_, i) => row(i * 12 + 1, { mode: 'pvp', xp: 70872, enemy: 'Rival', enemyLevel: 55 })),
    row(30, { mode: 'other', xp: 674_000, enemy: null, modeFrom: 'save' }),
  ].sort((a, b) => a.t.localeCompare(b.t));
  const now = T0 + 60 * 60_000;

  it('re-prices the hour at every level ahead', () => {
    const eta = levelEta(hour, { level: 55, xp: 1_000_000, now });
    expect(eta.fights).toBe(105); // the offline credit is not the farm
    expect(eta.steps.map((s) => s.level)).toEqual([55, 56, 57, 58, 59]);
    expect(eta.steps[0]!.pvePerHour).toBeCloseTo(1_246_100, 0);
    // PvE fades 12 points a level from 40%; PvP grows with the level's base
    expect(eta.steps[1]!.pvePerHour / eta.steps[0]!.pvePerHour).toBeCloseTo(0.28 / 0.4, 6);
    expect(eta.steps[4]!.pvePerHour).toBe(0);
    expect(eta.steps[4]!.pvpPerHour / eta.steps[0]!.pvpPerHour).toBeCloseTo(xpBaseAtLevel(59) / xpBaseAtLevel(55), 6);
    // the honest figure is far longer than XP left over today's rate
    expect(eta.hours!).toBeGreaterThan(2 * eta.flatHours!);
    expect(eta.xpLeft).toBe(xpToLevel(55, 1_000_000));
  });

  it('walks the level back across a level-up in the window', () => {
    const rows = [row(0, { xp: 12461 * 0.52 / 0.4 }), row(1, { xp: 12461 * 0.52 / 0.4, levelUp: 55 }), ...hour.slice(2)];
    // the first two fights were at level 54 (52%): priced at 55 they pay like the others
    const eta = levelEta(rows, { level: 55, xp: 0, now });
    const all55 = levelEta(hour, { level: 55, xp: 0, now });
    expect(eta.steps[0]!.pvePerHour).toBeCloseTo(all55.steps[0]!.pvePerHour, 0);
  });

  it('has no rate for a window of a few minutes', () => {
    const eta = levelEta(hour, { level: 55, xp: 0, now: T0 + 5 * 60_000, since: T0 });
    expect(eta.perHour).toBeNull();
    expect(eta.hours).toBeNull();
    expect(eta.xpLeft).toBeGreaterThan(0);
  });
});
