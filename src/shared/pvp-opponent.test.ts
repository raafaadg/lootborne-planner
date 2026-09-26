import { describe, expect, it } from 'vitest';
import type { PvpTurn } from './contracts';
import { inferPerks, inferPiercing } from './pvp-opponent';

function turn(p: Partial<PvpTurn> & { playerAttacking: boolean }): PvpTurn {
  return {
    damage: 0,
    crit: false,
    parried: false,
    healPlayer: 0,
    healEnemy: 0,
    counterPlayer: 0,
    counterEnemy: 0,
    suddenDeath: false,
    hpPlayer: 600,
    hpEnemy: 600,
    ...p,
  };
}

describe('inferPerks', () => {
  it('reads Thorns from half of every landed hit coming back', () => {
    const log = [30, 40, 50, 60].flatMap((d) => [turn({ playerAttacking: true, damage: d, counterEnemy: Math.round(d / 2) }), turn({ playerAttacking: false, damage: 10 })]);
    expect(inferPerks(log, 'them', 600).ids).toContain(19);
  });

  it('reads Thorns plus Mirror Echo from all of it coming back', () => {
    const log = [30, 40, 50].map((d) => turn({ playerAttacking: true, damage: d, counterEnemy: d }));
    expect(inferPerks(log, 'them', 600).ids).toEqual(expect.arrayContaining([19, 26]));
  });

  it('reads Last Breath from a lethal blow that leaves exactly a quarter', () => {
    const log = [turn({ playerAttacking: true, damage: 100, hpEnemy: 130 }), turn({ playerAttacking: false, damage: 5, hpEnemy: 130 }), turn({ playerAttacking: true, damage: 150, hpEnemy: 167 })];
    expect(inferPerks(log, 'them', 667).ids).toContain(29);
  });

  it('reads Dying Fury from plain hits getting much harder under 40% HP', () => {
    // our hit brings them to `left`, then they swing for `d`
    const log: PvpTurn[] = [];
    for (const [d, left] of [[40, 600], [40, 600], [40, 600], [40, 590], [80, 200], [80, 180]] as const) {
      log.push(turn({ playerAttacking: true, damage: 1, hpEnemy: left }));
      log.push(turn({ playerAttacking: false, damage: d, hpEnemy: left }));
    }
    expect(inferPerks(log, 'them', 600).ids).toContain(11);
  });

  it('does not see perks in a plain fight', () => {
    const log = [30, 40, 50, 60, 70].flatMap((d) => [turn({ playerAttacking: true, damage: d }), turn({ playerAttacking: false, damage: d })]);
    expect(inferPerks(log, 'them', 600).ids).toEqual([]);
  });
});

describe('inferPiercing', () => {
  const swings = (n: number, parried: number) =>
    Array.from({ length: n }, (_, i) => turn({ playerAttacking: false, parried: i < parried, damage: i < parried ? 0 : 20 }));

  it('flags a parry rate near 65% of ours', () => {
    // our stat 43%: pierced it becomes ~28%
    expect(inferPiercing(swings(60, 17), 'them', 43).pierce).toBe(true);
  });

  it('leaves a normal parry rate alone', () => {
    expect(inferPiercing(swings(60, 26), 'them', 43).pierce).toBe(false);
  });

  it('does not decide on a handful of swings', () => {
    expect(inferPiercing(swings(8, 1), 'them', 43).pierce).toBe(false);
  });
});
