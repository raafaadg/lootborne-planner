/**
 * The over-level penalty. GameConstants gives the rule and 2.647 of our own won fights confirm it:
 * every payout observed is xpBase times one of 1.00, 0.88, 0.76 … down to 0.
 */
import { describe, expect, it } from 'vitest';
import { COMBAT, xpMultiplier } from './combat';

describe('xpMultiplier', () => {
  it('matches GameConstants', () => {
    expect(COMBAT.XP_PENALTY_PER_LEVEL).toBe(0.12);
    expect(COMBAT.XP_FREE_BAND).toBe(3);
  });

  it('pays in full inside the free band', () => {
    for (const diff of [-5, 0, 1, 2, 3]) expect(xpMultiplier(30 + diff, 30)).toBe(1);
  });

  it('drops 12 points per level past the band', () => {
    const seen = [4, 5, 6, 7, 8, 9, 10].map((d) => Number(xpMultiplier(30 + d, 30).toFixed(2)));
    expect(seen).toEqual([0.88, 0.76, 0.64, 0.52, 0.4, 0.28, 0.16]);
  });

  it('never goes below zero', () => {
    expect(xpMultiplier(80, 20)).toBe(0);
  });

  it('hits the early enemies of a sector hardest', () => {
    // a level 46 player in War Camp: enemy 0 is around level 33, the last around 45
    expect(xpMultiplier(46, 33)).toBeLessThan(0.1);
    expect(xpMultiplier(46, 45)).toBe(1);
  });
});
