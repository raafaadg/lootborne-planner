/**
 * The fast fight model against the Monte Carlo, one item effect at a time. The fast model ranks
 * every PvE suggestion (the route, the per-slot alternatives, the Biblioteca), so an effect it does
 * not see is an item it undervalues — the "every 3 crits: triple damage" of the Emberdoom Greatsword
 * was one. Each case is a build that wins comfortably, so the fight's length is down to the damage.
 */
import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import { buildProfile, expectFight, mulberry32, sectorCategories, sectorEnemy, simulateFarm, simulateFight, type EnemyCategory, type PlayerProfile, type SectorInfo } from './combat';
import { sectorRun } from './gear-advisor';

const GORGE = (sectors as unknown as SectorInfo[])[5]!;
const cats = sectorCategories(GORGE, enemies as unknown as EnemyCategory[]);
const grigio = sectorEnemy(cats.find((c) => c.name === 'Deserter')!, 'Grigio');
const base = buildProfile({ hp: 2500, atk: 350, def: 120, crit: 20, parry: 30 }, []);
const withProcs = (patch: Partial<PlayerProfile['procs']>, p: Partial<PlayerProfile> = {}): PlayerProfile => ({ ...base, ...p, procs: { ...base.procs, ...patch } });

const CASES: Array<[string, PlayerProfile, number?]> = [
  ['nothing', base],
  ['every 3 attacks: ignores 40% DEF', withProcs({ everyNAttacks: [{ n: 3, damagePct: 0, flat: 0, ignoreDefPct: 0.4, critPct: 0 }] })],
  ['every 3 attacks: +12% CRIT', withProcs({ everyNAttacks: [{ n: 3, damagePct: 0, flat: 0, ignoreDefPct: 0, critPct: 0.12 }] })],
  ['every 3 crits: next ×3', withProcs({ everyNCrits: [{ n: 3, mult: 3 }] })],
  ['first hit taken: absorb 35%', withProcs({ firstHitTaken: { absorbPct: 0.35, hits: 1, counter: 0, atkPct: 0 } })],
  ['every 3 hits taken: absorb the next', withProcs({ everyNHitsTaken: { n: 3, absorbPct: 1 } })],
  ['on parry: heal 5', withProcs({ onParry: { ...base.procs.onParry, heal: 5 } })],
  ['on parry: +2 DEF for the fight', withProcs({ onParry: { ...base.procs.onParry, defBonus: 2 } })],
  ['on parry: next 2 hits +30%', withProcs({ onParry: { ...base.procs.onParry, damageNextPct: 0.3 }, riposteHits: 2 })],
  ['on parry: next attack crits', withProcs({ onParry: { ...base.procs.onParry, critNextPct: 1 } })],
  ['on parry: 20 damage back', withProcs({ onParry: { ...base.procs.onParry, counter: 20 } })],
  ['reflects 50%', withProcs({ reflectPct: 0.5 })],
  ['on crit: enemy DEF −2 for good', withProcs({ onCritDefDebuff: [{ amount: 2, seconds: 0 }] })],
  ['on crit: enemy DEF −4 for 5 s (two Eclipse Twinblades)', withProcs({ onCritDefDebuff: [{ amount: 2, seconds: 5 }, { amount: 2, seconds: 5 }] })],
  ['on crit: enemy DEF −12 for 4 s', withProcs({ onCritDefDebuff: [{ amount: 12, seconds: 4 }] })],
  ['on parry: +3 DEF for 5 s', withProcs({ parryDefBuffs: [{ amount: 3, seconds: 5 }] })],
  ['every 5 s: +3 ATK (Cindervow Gloves)', withProcs({ everyNSec: [{ seconds: 5, atk: 3, def: 0, allStats: 0, hp: 0, maxStacks: 0 }] })],
  ['every 5 s: +3 to all stats', withProcs({ everyNSec: [{ seconds: 5, atk: 0, def: 0, allStats: 3, hp: 0, maxStacks: 0 }] })],
  ['every 5 s: +1 DEF, max 5', withProcs({ everyNSec: [{ seconds: 5, atk: 0, def: 1, allStats: 0, hp: 0, maxStacks: 5 }] })],
  ['first hit taken: +20% ATK for the fight', withProcs({ firstHitTaken: { absorbPct: 0, hits: 1, counter: 60, atkPct: 0.2 } })],
  ['on crit: next attack ignores DEF', withProcs({ onCritIgnoreDefNext: true })],
  ['on crit: poison 28 over 4 s', withProcs({ critPoison: { damage: 28, seconds: 4 } })],
  ['Pent-Up Wrath', withProcs({ stackingCrit: { step: 0.1, max: 0.5 } })],
  ['Rising Momentum', withProcs({ risingDamage: { step: 0.04, max: 0.4 } })],
  ['+25% above 70% HP', withProcs({ aboveHpDamage: { abovePct: 0.7, bonus: 0.25 } })],
  ['Coup de Grace', withProcs({ executeBelowPct: 0.1 })],
  ['Colossus Hunter', withProcs({ enemyMaxHpDamagePct: 0.01 })],
  ['Blood Curse drain', withProcs({ drainPctOfDamageDealt: 0.05 })],
  ['first attack crits', withProcs({ firstAttack: { crit: true, damagePct: 0, hits: 1 } })],
  ['Sunder Oil', { ...base, sunderPerHit: 4 }, 0.1],
  ['Immolation', { ...base, immolationPctPerTurn: 0.005 }],
  ["Executioner's Draught", { ...base, executeBelowHpBonus: 0.4 }],
];

describe('the fast model agrees with the Monte Carlo on each item effect', () => {
  it.each(CASES)('%s', (_, p, tol = 0.05) => {
    const rng = mulberry32(3);
    const n = 3000;
    let turns = 0;
    let lost = 0;
    for (let i = 0; i < n; i++) {
      const r = simulateFight(p, p.maxHp, grigio, rng);
      turns += r.turns;
      lost += p.maxHp - r.endHp;
    }
    const ex = expectFight(p, grigio, 5);
    const mcRounds = turns / n / 2;
    expect(Math.abs(ex.rounds - mcRounds) / mcRounds).toBeLessThan(tol);
    expect(Math.abs(ex.regen - ex.hpDelta - lost / n) / (lost / n)).toBeLessThan(tol);
  });
});

describe('"below X% HP" along a run', () => {
  it('counts a low-HP DEF bonus once the run has worn us down', () => {
    const glass = buildProfile({ hp: 600, atk: 150, def: 40, crit: 10, parry: 10 }, []);
    const tempest = { ...glass, procs: { ...glass.procs, belowHp: [{ pct: 0.4, atkPct: 0, atkFlat: 0, defPct: 0.2, allStats: 0, lifestealPct: 0, regenPerSec: 0, regenPerAttack: 0, absorbPct: 0, immuneCrit: false }] } };
    const plain = sectorRun(glass, GORGE, cats);
    const low = sectorRun(tempest, GORGE, cats);
    expect(low.depth).toBeGreaterThan(plain.depth);
    // it only acts under the line: the first fights, from full HP, are the same
    expect(expectFight(tempest, grigio, 5).hpDelta).toBeCloseTo(expectFight(glass, grigio, 5).hpDelta, 6);
  });
});

describe('the run against the farm played out', () => {
  // the farm loop: fight from enemy 0 until a fight is lost. XP/h and fights won per attempt from the
  // closed-form run (fight win chances, HP carried as a distribution) against the Monte Carlo's
  const CAVE = (sectors as unknown as SectorInfo[])[6]!;
  const caveCats = sectorCategories(CAVE, enemies as unknown as EnemyCategory[]);
  const BUILDS: Array<[string, PlayerProfile, SectorInfo, EnemyCategory[]]> = [
    ['a glass cannon in the Gorge', buildProfile({ hp: 600, atk: 170, def: 60, crit: 30, parry: 20 }, []), GORGE, cats],
    ['a balanced build in the Gorge', buildProfile({ hp: 1100, atk: 120, def: 140, crit: 20, parry: 40 }, []), GORGE, cats],
    ['a tank in the Gorge', buildProfile({ hp: 1500, atk: 70, def: 230, crit: 10, parry: 50 }, []), GORGE, cats],
    ['a balanced build in the Cave', buildProfile({ hp: 1200, atk: 150, def: 170, crit: 25, parry: 45 }, []), CAVE, caveCats],
  ];
  it.each(BUILDS)('%s', (_, p, sector, cs) => {
    const run = sectorRun(p, sector, cs, undefined, 58);
    const mc = simulateFarm(p, sector, cs, { attempts: 600, playerLevel: 58, seed: 11 });
    if (mc.xpPerHour > 50_000) expect(Math.abs(run.xpPerHour - mc.xpPerHour) / mc.xpPerHour).toBeLessThan(0.25);
    else expect(run.xpPerHour).toBeLessThan(150_000);
    expect(Math.abs(run.depth - mc.depth)).toBeLessThan(Math.max(1.5, 0.25 * mc.depth));
  });
});
