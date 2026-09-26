import { describe, expect, it } from 'vitest';
import { buildProfile, mulberry32 } from './combat';
import { duelOdds, forPvp, simulateDuel, suddenDeathMult, type PvpProfile } from './duel';
import { mergeProcs } from './item-effects';
import { mergePerkCombat, mergePerkProcs } from './perk-mods';

type StatBlock = { hp: number; atk: number; def: number; crit: number; parry: number };

function fighter(s: StatBlock, perkIds: number[] = [], patch: Partial<PvpProfile> = {}): PvpProfile {
  // as the app builds a fighter: combat-time perk modifiers plus the perk mechanics
  const base = buildProfile(s, [], mergePerkCombat(perkIds));
  return { ...forPvp({ ...base, procs: mergeProcs(base.procs, mergePerkProcs(perkIds)) }, perkIds), ...patch };
}

/** A fixed sequence of rolls, then a default. */
function script(rolls: number[], rest = 0.9): () => number {
  let i = 0;
  return () => (i < rolls.length ? rolls[i++]! : rest);
}

describe('sudden death', () => {
  it('matches StepTurnAndGetDamageMultiplier', () => {
    expect(suddenDeathMult(1)).toBe(1);
    expect(suddenDeathMult(59)).toBe(1);
    expect(suddenDeathMult(60)).toBeCloseTo(1.05);
    expect(suddenDeathMult(69)).toBeCloseTo(1.05);
    expect(suddenDeathMult(70)).toBeCloseTo(1.05 ** 2);
    expect(suddenDeathMult(110)).toBeCloseTo(1.05 ** 6);
    expect(suddenDeathMult(100_000)).toBe(1000);
  });
});

describe('forPvp', () => {
  it("applies Rival's Calling and switches off the PvE-only perks", () => {
    const p = fighter({ hp: 500, atk: 50, def: 50, crit: 0, parry: 0 }, [14, 17]);
    expect(p.damageDealtMult).toBeCloseTo(1.3);
    expect(p.procs.enemyMaxHpDamagePct).toBe(0);
  });
});

describe('simulateDuel', () => {
  it('keeps a parry-armed crit through a parried swing', () => {
    // us: Dawnguard Pendant ("on parry: next attack 100% crit"), no crit of our own
    const us = fighter({ hp: 10_000, atk: 50, def: 0, crit: 0, parry: 50 }, [], {});
    us.procs = { ...us.procs, onParry: { ...us.procs.onParry, critNextPct: 1 } };
    const them = fighter({ hp: 10_000, atk: 50, def: 0, crit: 0, parry: 50 });
    const rng = script([
      0.5, 0.1, // 1 us: parried by them
      0.5, 0.1, 0.5, // 2 them: we parry -> our next attack is armed
      0.5, 0.1, // 3 us: the armed attack is parried
      0.5, 0.9, 0.9, // 4 them: lands, no crit
      0.5, 0.9, // 5 us: lands, and must still be a crit
    ]);
    const r = simulateDuel(us, them, rng, { log: true });
    expect(r.log![2]!.parried).toBe(true);
    expect(r.log![4]!.parried).toBe(false);
    expect(r.log![4]!.crit).toBe(true);
  });

  it('scales parry by Armor Piercer instead of subtracting it', () => {
    const us = fighter({ hp: 1e7, atk: 1, def: 0, crit: 0, parry: 0 }, [31]);
    const them = fighter({ hp: 1e7, atk: 1, def: 0, crit: 0, parry: 55 });
    const r = simulateDuel(us, them, mulberry32(3), { log: true });
    const ours = r.log!.filter((t) => t.playerAttacking);
    const rate = ours.filter((t) => t.parried).length / ours.length;
    expect(rate).toBeGreaterThan(0.3); // subtracting would give 20%
    expect(rate).toBeLessThan(0.41); // 55% × 0.65 = 35.75%
  });

  it('sends half of every landed hit back with Thorns', () => {
    const us = fighter({ hp: 1000, atk: 100, def: 0, crit: 0, parry: 0 });
    const them = fighter({ hp: 5000, atk: 1, def: 0, crit: 0, parry: 0 }, [19]);
    const r = simulateDuel(us, them, script([0.5, 0.9, 0.9]), { log: true });
    const first = r.log![0]!;
    expect(first.damage).toBe(100);
    expect(first.counterEnemy).toBe(50);
    expect(first.playerHp).toBe(950);
  });

  it('doubles Thorns when Mirror Echo sits right behind it', () => {
    expect(mergePerkProcs([19, 26]).reflectPct).toBeCloseTo(1);
    expect(mergePerkProcs([26, 19]).reflectPct).toBeCloseTo(0.5);
    // next to a stat-only perk it copies nothing
    expect(mergePerkProcs([10, 26]).reflectPct ?? 0).toBe(0);
  });

  it('leaves a quarter of max HP once with Last Breath', () => {
    const us = fighter({ hp: 1000, atk: 500, def: 0, crit: 0, parry: 0 });
    const them = fighter({ hp: 400, atk: 1, def: 0, crit: 0, parry: 0 }, [29]);
    const r = simulateDuel(us, them, script([0.5, 0.9, 0.9, 0.5, 0.9, 0.9, 0.5, 0.9, 0.9]), { log: true });
    expect(r.log![0]!.enemyHp).toBe(100);
    expect(r.won).toBe(true); // the second lethal blow is not forgiven
  });

  it('makes the side that took the blow lose when the reflect kills both', () => {
    const us = fighter({ hp: 40, atk: 100, def: 0, crit: 0, parry: 0 });
    const them = fighter({ hp: 50, atk: 1, def: 0, crit: 0, parry: 0 }, [19]);
    const r = simulateDuel(us, them, script([0.5, 0.9, 0.9]));
    expect(r.aHp).toBe(0);
    expect(r.bHp).toBe(0);
    expect(r.won).toBe(true);
  });

  it('boosts the next TWO landed attacks after a parry with Aggressive Riposte', () => {
    const us = fighter({ hp: 10_000, atk: 100, def: 0, crit: 0, parry: 50 }, [8]);
    const them = fighter({ hp: 10_000, atk: 1, def: 0, crit: 0, parry: 0 });
    // swing 2 is theirs and we parry it (0.1 < 50%); every other roll is 0.5 (plain, no crit)
    const r = simulateDuel(us, them, script([0.5, 0.5, 0.5, 0.5, 0.1], 0.5), { log: true });
    const ours = r.log!.filter((t) => t.playerAttacking).map((t) => t.damage);
    expect(ours.slice(0, 4)).toEqual([100, 135, 135, 100]);
  });

  it("turns Blood Curse's overheal into a shield that soaks the next hit", () => {
    const us = fighter({ hp: 1000, atk: 100, def: 0, crit: 0, parry: 0 }, [23]);
    const them = fighter({ hp: 10_000, atk: 20, def: 0, crit: 0, parry: 0 });
    const r = simulateDuel(us, them, script([], 0.5), { log: true });
    // our hit: 13 lifesteal at full HP becomes shield, then 11% drain: 1000 - 11
    expect(r.log![0]!.playerHp).toBe(989);
    // their 20 lands on the 13 shield first: 989 - 7
    expect(r.log![1]!.playerHp).toBe(982);
  });

  it('gives two builds the same dice for the same seed', () => {
    const us = fighter({ hp: 600, atk: 60, def: 100, crit: 20, parry: 40 });
    const them = fighter({ hp: 650, atk: 55, def: 110, crit: 25, parry: 35 });
    expect(duelOdds(us, them, 50, 9)).toEqual(duelOdds(us, them, 50, 9));
  });
});

describe('every N attacks, as ResolveAttack does it', () => {
  // a log of our swings: which ones landed and for how much
  const ours = (a: PvpProfile, b: PvpProfile, rng: () => number) => (simulateDuel(a, b, rng, { log: true }).log ?? []).filter((t) => t.playerAttacking);

  it('counts only the swings that got through and boosts that same swing (Heavy Lunge)', () => {
    // no crits, damage roll fixed: every landed swing is the same unless Heavy Lunge fires
    const us = fighter({ hp: 5000, atk: 100, def: 0, crit: 0, parry: 0 }, [6]);
    const wall = fighter({ hp: 100000, atk: 1, def: 0, crit: 0, parry: 50 });
    const swings = ours(us, wall, mulberry32(3)).slice(0, 60);
    const landed = swings.filter((t) => !t.parried);
    const plain = Math.min(...landed.map((t) => t.damage));
    landed.forEach((t, i) => {
      const boosted = (i + 1) % 3 === 0;
      if (boosted) expect(t.damage).toBeGreaterThan(plain * 2);
      else expect(t.damage).toBeLessThan(plain * 1.6);
    });
    // "ignores parry" is dead: the parry rate stays the defender's
    const parried = swings.filter((t) => t.parried).length / swings.length;
    expect(parried).toBeGreaterThan(0.3);
  });

  it("an 'every 3 hits taken' absorb eats exactly Heavy Lunge's boosted hit", () => {
    const us = fighter({ hp: 5000, atk: 100, def: 0, crit: 0, parry: 0 }, [6]);
    const shield = { ...fighter({ hp: 100000, atk: 1, def: 0, crit: 0, parry: 30 }) };
    shield.procs = { ...shield.procs, everyNHitsTaken: { n: 3, absorbPct: 1 } };
    const landed = ours(us, shield, mulberry32(5)).filter((t) => !t.parried).slice(0, 30);
    landed.forEach((t, i) => {
      if ((i + 1) % 3 === 0) expect(t.damage).toBe(0);
      else expect(t.damage).toBeGreaterThan(0);
    });
  });

  it('caps DEF penetration at 50% in PvP (Armor Piercer copied by Mirror Echo would be 70%)', () => {
    const pierce = fighter({ hp: 5000, atk: 100, def: 0, crit: 0, parry: 0 }, [31, 26]);
    expect(pierce.procs.ignoreDefPct).toBeCloseTo(0.7);
    const half = fighter({ hp: 5000, atk: 100, def: 0, crit: 0, parry: 0 }, [], {});
    half.procs = { ...half.procs, ignoreDefPct: 0.5 };
    const tank = fighter({ hp: 100000, atk: 1, def: 300, crit: 0, parry: 0 });
    const avg = (p: PvpProfile) => {
      const l = ours(p, tank, mulberry32(9)).slice(0, 40);
      return l.reduce((a, t) => a + t.damage, 0) / l.length;
    };
    // same DEF ignored (50%); only the parry part of Armor Piercer differs, and the tank has none
    expect(avg(pierce)).toBeCloseTo(avg(half), 0);
  });
});
