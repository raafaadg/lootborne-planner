import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import sectors from '../../game-data/sectors.json';
import {
  COMBAT,
  adviseOptions,
  advisePlan,
  breakEvenDef,
  buildProfile,
  elementMultiplier,
  elementOptions,
  categoryWeights,
  expectFight,
  expectedHit,
  itemSustain,
  hitDamage,
  regenAfterWin,
  rosterAt,
  roundHalfEven,
  sectorCategories,
  sectorEnemy,
  simulateFight,
  simulateSector,
  mulberry32,
  withPoints,
  type EnemyCategory,
  type SectorInfo,
} from './combat';

const CATS = enemies as unknown as EnemyCategory[];
const VILLAGE = (sectors as unknown as SectorInfo[])[1]!;
const villageCats = sectorCategories(VILLAGE, CATS);
const cutthroat = villageCats.find((c) => c.name === 'Cutthroat')!;
const viola = cutthroat.variants.find((v) => v.color === 'Viola')!;
const blu = cutthroat.variants.find((v) => v.color === 'Blu')!;

// Final stats read live from StatsCalculator.GetTotalStats, with Crimson Vow (flatHealPerHit 3).
const LIVE = buildProfile({ hp: 445, atk: 28.2, def: 12.1, crit: 18.16, parry: 5.6 }, [], { flatHealPerHit: 3 });

describe('primitives', () => {
  it('RoundToInt sends halves to the even neighbour', () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(2.49)).toBe(2);
    expect(roundHalfEven(2.51)).toBe(3);
  });

  it('a landed hit always deals at least 1', () => {
    expect(hitDamage(0.1, 500, false, 0.8)).toBe(1);
  });

  it('non-crit range matches the live turns (21-30 seen, 20-30 predicted)', () => {
    expect(hitDamage(28.2, 7.5, false, 0.8)).toBe(20);
    expect(hitDamage(28.2, 7.5, false, 1.2)).toBe(30);
  });
});

describe('expected damage vs live measurements', () => {
  it('Cutthroat Viola hitting DEF 12.1: ~5.4 per landed hit (observed 5.0 over 41 hits)', () => {
    expect(expectedHit(viola.atk, 12.1, viola.crit / 100)).toBeCloseTo(5.36, 1);
  });

  it('player (ATK 28.2, CRIT 18.2 %) hitting Cutthroat Blu: ~29.6 (observed 30.3 over 32 hits)', () => {
    expect(expectedHit(28.2, blu.def, 0.1816)).toBeCloseTo(29.6, 0);
  });

  it('end-of-fight regen in Village is 13 % of max HP', () => {
    expect(regenAfterWin(LIVE, 1)).toBe(58);
  });

  it('a Cutthroat Viola fight costs HP net of Crimson Vow and regen (observed -36)', () => {
    const ex = expectFight(LIVE, viola, 1);
    expect(ex.hpDelta).toBeLessThan(0);
    expect(ex.hpDelta).toBeGreaterThan(-70);
  });
});

describe('sector roster (PickEnemyForBattle)', () => {
  it('category weights and every roll at an index sum to 1', () => {
    expect(categoryWeights(5, 0.3).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    for (const i of [0, 10, 27, 53]) {
      expect(rosterAt(VILLAGE, villageCats, i).reduce((a, r) => a + r.prob, 0)).toBeCloseTo(1);
    }
  });

  it('the first enemies are the first category, the last ones the last category', () => {
    const first = rosterAt(VILLAGE, villageCats, 0).sort((a, b) => b.prob - a.prob)[0]!;
    const last = rosterAt(VILLAGE, villageCats, 53).sort((a, b) => b.prob - a.prob)[0]!;
    expect(first.catIndex).toBe(0);
    expect(last.catIndex).toBe(villageCats.length - 1);
    expect(first.variant.color).toBe('Grigio');
    expect(last.variant.color).not.toBe('Grigio');
  });
});

describe('simulation', () => {
  it('one fight is deterministic for a seed and never ends with both alive', () => {
    const a = simulateFight(LIVE, LIVE.maxHp, viola, mulberry32(1));
    const b = simulateFight(LIVE, LIVE.maxHp, viola, mulberry32(1));
    expect(a).toEqual(b);
    expect(a.turns).toBeLessThan(COMBAT.MAX_TURNS);
  });

  it('simulated fights agree with the expectation on average', () => {
    const rng = mulberry32(99);
    let lost = 0;
    const n = 400;
    for (let i = 0; i < n; i++) lost += LIVE.maxHp - simulateFight(LIVE, LIVE.maxHp, viola, rng).endHp;
    const ex = expectFight(LIVE, viola, 1);
    expect(lost / n).toBeCloseTo(-(ex.hpDelta - ex.regen), -1);
  });

  it('sector survival curve only goes down and clearProb is its last point', () => {
    const r = simulateSector(LIVE, VILLAGE, villageCats, { runs: 200, seed: 5 });
    for (let i = 1; i < r.survival.length; i++) expect(r.survival[i]!).toBeLessThanOrEqual(r.survival[i - 1]!);
    expect(r.clearProb).toBeCloseTo(r.survival.at(-1)!, 5);
  });
});

describe('advisor', () => {
  it('break-even DEF zeroes the expected HP change against that enemy', () => {
    const be = breakEvenDef(LIVE, viola, 1);
    expect(be.alreadyOk).toBe(false);
    expect(be.def!).toBeGreaterThan(LIVE.def);
    expect(Math.abs(expectFight({ ...LIVE, def: be.def! }, viola, 1).hpDelta)).toBeLessThan(0.5);
  });

  it('options add exactly the per-point values', () => {
    const q = withPoints(LIVE, { def: 5, atk: 5 });
    expect(q.def).toBeCloseTo(LIVE.def + 4);
    expect(q.atk).toBeCloseTo(LIVE.atk + 1);
    expect(adviseOptions(LIVE, VILLAGE, villageCats, 5)).toHaveLength(5);
  });

  it('the plan spends every point', () => {
    const plan = advisePlan(LIVE, VILLAGE, villageCats, 10);
    expect(Object.values(plan.plan).reduce((a, b) => a + b, 0)).toBe(10);
    expect(plan.steps).toHaveLength(10);
  });
});

describe('elements (ENEMY_RESIST_PCT 15 %, ENEMY_WEAK_BOTH_WEAPONS_PCT 40 %)', () => {
  const kobold = sectorEnemy(sectorCategories((sectors as unknown as SectorInfo[])[2]!, CATS).find((c) => c.name === 'Kobold')!, 'Blu');

  it('Kobold resists Flame and is weak to Shadow, like the live EnemyState', () => {
    expect(kobold.resist).toBe('Flame');
    expect(kobold.weak).toBe('Shadow');
  });

  it('one weapon on the weakness is +15 %, both are +40 %, a resisted one is -15 %', () => {
    expect(elementMultiplier(['Shadow'], kobold)).toBeCloseTo(1.15);
    expect(elementMultiplier(['Shadow', 'Shadow'], kobold)).toBeCloseTo(1.4);
    expect(elementMultiplier(['Flame'], kobold)).toBeCloseTo(0.85);
    expect(elementMultiplier(['Flame', 'Flame'], kobold)).toBeCloseTo(0.7);
    expect(elementMultiplier(['Shadow', 'Flame'], kobold)).toBeCloseTo(1);
    expect(elementMultiplier(['Nessuna', 'Holy'], kobold)).toBe(1);
  });

  it('the element changes the fight: Shadow weapons kill faster than Flame ones', () => {
    const shadow = { ...LIVE, weaponElements: ['Shadow' as const, 'Shadow' as const] };
    const flame = { ...LIVE, weaponElements: ['Flame' as const, 'Flame' as const] };
    expect(expectFight(shadow, kobold, 2).rounds).toBeLessThan(expectFight(flame, kobold, 2).rounds * 0.6);
  });

  it('ranks elements for the Forest mix (Shadow good, Flame bad)', () => {
    const forest = (sectors as unknown as SectorInfo[])[2]!;
    const opts = elementOptions(forest, sectorCategories(forest, CATS));
    const best = [...opts].sort((a, b) => b.both - a.both)[0]!;
    const flame = opts.find((o) => o.element === 'Flame')!;
    expect(best.element).toBe('Shadow');
    expect(flame.one).toBeLessThan(1);
    expect(flame.resistShare).toBeGreaterThan(0.5);
  });
});

describe('item procs the fight actually uses', () => {
  const item = (effects: string[]) =>
    ({ uid: 1, templateId: 1, itemName: 'x', slot: 0, rarity: 0, category: 0, hp: 0, atk: 0, def: 0, crit: 0, parry: 0, effects, isNew: false, locked: false, isBossExclusive: false, grantSource: 0 }) as never;
  const stats = { hp: 539, atk: 118.5, def: 124.6, crit: 38.9, parry: 19.4 };

  it('reads "Every N attacks", "On parry" and "Below X% HP" off the equipped gear', () => {
    const s = itemSustain([
      item(['Every 4 attacks: +30% damage next attack']),
      item(['On parry: next attack ha 100% CRIT', 'Below 50% HP: regenerates 3 HP/sec']),
      item(['If dual wielding weapons: +6 ATK, +5% CRIT']), // a stat synergy, counted elsewhere
      item(['Reduces Stamina consumption by 10%']), // genuinely outside the model
    ]);
    expect(s.everyNAttacks).toEqual([{ n: 4, damagePct: 0.3, flat: 0, ignoreDefPct: 0, critPct: 0 }]);
    expect(s.onParry.critNextPct).toBe(1);
    expect(s.belowHp[0]).toMatchObject({ pct: 0.5, regenPerSec: 3 });
    expect(s.modelled).toBe(3);
    expect(s.ignored).toHaveLength(0); // the stamina line is out of combat, not unknown
  });

  it('"Every 4 attacks: +30%" is worth 7.5 % more damage per attack', () => {
    const plain = buildProfile(stats, []);
    const proc = buildProfile(stats, [item(['Every 4 attacks: +30% damage next attack'])]);
    expect(expectFight(proc, viola, 1).playerHit).toBeCloseTo(expectFight(plain, viola, 1).playerHit * 1.075, 1);
  });

  it('a parry that arms the next attack raises the crit rate by the parry rate', () => {
    const plain = buildProfile(stats, []);
    const proc = buildProfile(stats, [item(['On parry: next attack ha 100% CRIT'])]);
    expect(expectFight(proc, viola, 1).playerHit).toBeGreaterThan(expectFight(plain, viola, 1).playerHit);
    // two copies cannot push past one guaranteed crit per parry
    const twice = buildProfile(stats, [item(['On parry: next attack ha 100% CRIT']), item(['On parry: next attack ha 100% CRIT'])]);
    expect(twice.procs.onParry.critNextPct).toBe(1);
  });

  it('the below-half-HP regen only pays while we are actually low', () => {
    const proc = buildProfile(stats, [item(['Below 50% HP: regenerates 3 HP/sec'])]);
    const plain = buildProfile(stats, []);
    const low = Math.round(stats.hp * 0.3);
    expect(simulateFight(proc, low, viola, mulberry32(11)).endHp).toBeGreaterThan(simulateFight(plain, low, viola, mulberry32(11)).endHp);
    // starting at full HP against a weak enemy it never triggers
    expect(simulateFight(proc, stats.hp, viola, mulberry32(11)).endHp).toBe(simulateFight(plain, stats.hp, viola, mulberry32(11)).endHp);
  });
});
