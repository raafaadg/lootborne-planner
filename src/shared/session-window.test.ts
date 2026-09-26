import { describe, expect, it } from 'vitest';
import type { GameEvent } from './contracts';
import { XP_WINDOW_MS, xpWindow } from './session-window';

const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const at = (msAgo: number) => new Date(T0 - msAgo).toISOString();

function battle(msAgo: number, xp: number): GameEvent {
  return {
    id: `b${msAgo}`,
    t: at(msAgo),
    source: 'save',
    kind: 'battle',
    xp,
    hp: [100, 90],
    stamina: [50, 49],
    sector: 4,
    enemyIndex: 3,
    pity: 0,
  };
}

function death(msAgo: number): GameEvent {
  return { id: `d${msAgo}`, t: at(msAgo), source: 'save', kind: 'death', sector: 4, deathsInSector: 1 };
}

describe('xpWindow', () => {
  const since = T0 - 60 * 60_000; // counting for an hour

  it('adds up only the battles inside the window', () => {
    const events = [battle(20 * 60_000, 9999), battle(9 * 60_000, 100), battle(60_000, 50), death(30_000)];
    const w = xpWindow(events, since, T0);
    expect(w.xp).toBe(150);
    expect(w.battles).toBe(2);
  });

  it('extrapolates the rate from the full window once it is full', () => {
    const w = xpWindow([battle(60_000, 1000)], since, T0);
    expect(w.full).toBe(true);
    expect(w.spanMs).toBe(XP_WINDOW_MS);
    expect(w.perHour).toBe(6000); // 1000 XP per 10 minutes
  });

  it('never reaches back past the moment the counters were zeroed', () => {
    const reset = T0 - 3 * 60_000;
    const w = xpWindow([battle(8 * 60_000, 500), battle(60_000, 200)], reset, T0);
    expect(w.xp).toBe(200);
    expect(w.spanMs).toBe(3 * 60_000);
    expect(w.full).toBe(false);
    expect(w.perHour).toBe(4000); // 200 XP in 3 minutes
  });

  it('withholds the rate while the span is too short to mean anything', () => {
    const w = xpWindow([battle(5_000, 800)], T0 - 20_000, T0);
    expect(w.xp).toBe(800);
    expect(w.perHour).toBeNull(); // 800 XP in 20 s would read as 144k XP/h
  });

  it('decays as the clock moves even with no new events', () => {
    const events = [battle(0, 300)];
    expect(xpWindow(events, since, T0).xp).toBe(300);
    expect(xpWindow(events, since, T0 + XP_WINDOW_MS + 1).xp).toBe(0);
  });
});
