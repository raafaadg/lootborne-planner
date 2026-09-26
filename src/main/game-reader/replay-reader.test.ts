import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReplay, summarize, ticksToIso } from './replay-reader';

describe('parseReplay', () => {
  const raw = readFileSync(join(__dirname, '../../../fixtures/replays/sample.json'), 'utf8');
  const r = parseReplay('sample.json', raw);

  it('reads the outcome, both fighters and one entry per turn', () => {
    expect(typeof r.won).toBe('boolean');
    expect(r.opponent.name.length).toBeGreaterThan(0);
    expect(r.opponent.level).toBeGreaterThan(0);
    expect(r.turns).toBeGreaterThan(0);
    expect(r.log).toHaveLength(r.turns);
  });

  it('records the gear of both sides', () => {
    expect(r.opponent.gear.length).toBeGreaterThan(0);
    for (const g of r.opponent.gear) {
      expect(g.slot.length).toBeGreaterThan(0);
      expect(g.name.length).toBeGreaterThan(0);
    }
    expect(r.player.gear.some((g) => g.slot.startsWith('Arma'))).toBe(true);
  });

  it('the loser ends at 0 HP', () => {
    const last = r.log!.at(-1)!;
    expect(r.won ? last.hpEnemy : last.hpPlayer).toBe(0);
  });

  it('tallies attacks, crits and parries per side', () => {
    expect(r.you.attacks + r.them.attacks).toBe(r.turns);
    expect(r.you.landed + r.you.parried).toBe(r.you.attacks);
    expect(r.you.crits).toBeLessThanOrEqual(r.you.landed);
    // every point of damage in the log belongs to exactly one side
    const total = r.log!.filter((t) => !t.parried).reduce((a, t) => a + t.damage, 0);
    expect(r.you.damage + r.them.damage).toBe(total);
  });

  it('summaries drop the turn log but keep the counters', () => {
    const s = summarize(r);
    expect(s.log).toBeUndefined();
    expect(s.you).toEqual(r.you);
  });

  it('converts .NET ticks to ISO time', () => {
    expect(ticksToIso(639256378631072408).startsWith('2026-09-22')).toBe(true);
  });
});
