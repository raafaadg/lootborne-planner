import { describe, expect, it } from 'vitest';
import { AppState } from './app-state';
import { DEFAULT_SETTINGS } from './storage/settings';

/** What the agent sent for a real opponent, 4 ms apart, in this order. */
const SNAPSHOT = {
  ev: 'pvp_snapshot',
  name: 'bilibili柳五',
  level: 47,
  power: 2482,
  maxHp: 667,
  atk: 70.3,
  def: 56.7,
  crit: 24.4,
  parry: 32.45,
  perkIds: [17, 31, 29, 11],
  rankingPoints: -1,
  mmr: 1897,
  matches: 376,
};
const COMBAT_START = {
  ev: 'combat_start',
  enemy: { name: 'bilibili柳五', color: 0, hp: 667, maxHp: 667, atk: 70.3, def: 56.7, crit: 24.4, parry: 32.45, level: 47, isPvP: true, isArenaBoss: false, xpWin: 36562, resist: 0, resist2: 0, weak: 0, dropChance: 1 },
};

describe('PvP scouting', () => {
  it('keeps the perks when combat_start follows the snapshot', () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onAgentMessage(SNAPSHOT);
    s.onAgentMessage(COMBAT_START);
    const scout = s.scouts['bilibili柳五'];
    expect(scout?.perkIds).toEqual([17, 31, 29, 11]);
    expect(scout?.mmr).toBe(1897);
    expect(scout?.power).toBe(2482);
    expect(scout?.def).toBeCloseTo(56.7);
  });

  it('keeps them in the opposite order too', () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onAgentMessage(COMBAT_START);
    s.onAgentMessage(SNAPSHOT);
    expect(s.scouts['bilibili柳五']?.perkIds).toEqual([17, 31, 29, 11]);
  });

  it('drops empty perk slots', () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onAgentMessage({ ...SNAPSHOT, perkIds: [17, 0, -1, 11] });
    expect(s.scouts['bilibili柳五']?.perkIds).toEqual([17, 11]);
  });
});
