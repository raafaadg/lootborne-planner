import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffSaves } from './save-diff';
import { parseSave } from './save-reader';

// Real consecutive saves captured by spikes/s1_save_watcher.py (build c4889dfe).
const load = (name: string, side: 'before' | 'after') =>
  parseSave(readFileSync(join(__dirname, '../../../fixtures/saves', `${name}.${side}.json`), 'utf8')).state;
const pair = (name: string) => diffSaves(load(name, 'before'), load(name, 'after'));
const kinds = (name: string) => pair(name).map((e) => e.kind);

describe('parseSave', () => {
  it('unwraps the {payload, checksum, sigVersion} wrapper', () => {
    const raw = readFileSync(join(__dirname, '../../../fixtures/saves/plain-battle.after.json'), 'utf8');
    const { state, sigVersion } = parseSave(raw);
    expect(sigVersion).toBe(8);
    expect(state.name).toBe('CatNation');
    expect(Array.isArray(state.inventory)).toBe(true);
  });

  it('rejects a half-written file', () => {
    expect(() => parseSave('{"payload":"{\\"level\\":')).toThrow();
  });
});

describe('diffSaves on real save pairs', () => {
  it('a plain battle yields exactly one battle event with the XP gained', () => {
    const events = pair('plain-battle');
    expect(events).toHaveLength(1);
    const [battle] = events;
    expect(battle?.kind).toBe('battle');
    if (battle?.kind === 'battle') {
      const before = load('plain-battle', 'before');
      const after = load('plain-battle', 'after');
      expect(battle.xp).toBe(after.xp - before.xp);
      expect(battle.stamina[0]).toBeGreaterThan(battle.stamina[1]);
    }
  });

  it('a new inventory uid is a drop with its rarity name', () => {
    const drop = pair('drop').find((e) => e.kind === 'drop');
    expect(drop).toBeDefined();
    if (drop?.kind === 'drop') {
      expect(drop.item.rarity).toMatch(/^(Common|Rare|Epic|Legendary|Mythic|Ascended)$/);
      expect(drop.item.grantSource).toBe('CombatDrop');
    }
  });

  it('a death is reported with the battle marked as lost', () => {
    const events = pair('death');
    expect(kinds('death')).toContain('death');
    const battle = events.find((e) => e.kind === 'battle');
    expect(battle?.kind === 'battle' && battle.won).toBe(false);
  });

  it('level up reports the new level and the unspent points', () => {
    const up = pair('level-up').find((e) => e.kind === 'level_up');
    expect(up?.kind === 'level_up' && up.to === up.from + 1).toBe(true);
    expect(up?.kind === 'level_up' && up.unspent).toBe(5);
  });

  it('moving to the next sector after clearing it is a cleared sector_change, not a death', () => {
    const events = pair('sector-clear');
    const change = events.find((e) => e.kind === 'sector_change');
    expect(change?.kind === 'sector_change' && change.cleared).toBe(true);
    expect(kinds('sector-clear')).not.toContain('death');
  });

  it('forging consumes many items at once: one item_removed event listing them', () => {
    const removed = pair('forge').filter((e) => e.kind === 'item_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.kind === 'item_removed' && removed[0].items.length).toBeGreaterThanOrEqual(5);
  });

  it('battleActive going false is a pause', () => {
    expect(kinds('pause')).toContain('battle_paused');
  });
});

describe('diffSaves in the Arena', () => {
  // a level-60 save in the Arena: no XP, the sector counters stand still, the wave and kill count move
  const arena = (wave: number, kills: number, hp = 1000) => ({ ...load('plain-battle', 'before'), level: 60, xp: 0, endlessMode: true, waveIndex: wave, waveKillCount: kills, currentHp: hp });
  const battle = (a: ReturnType<typeof arena>, b: ReturnType<typeof arena>) => diffSaves(a, b).find((e) => e.kind === 'battle');

  it('a kill in the wave is a won Arena fight, with its wave and kill', () => {
    expect(battle(arena(3, 4), arena(3, 5))).toMatchObject({ mode: 'arena', wave: 3, waveKill: 5, won: true, xp: 0 });
  });

  it('the tenth kill moves the wave', () => {
    expect(battle(arena(3, 9), arena(4, 0))).toMatchObject({ mode: 'arena', wave: 3, waveKill: 10, won: true });
  });

  it('going back is a death', () => {
    expect(battle(arena(7, 2), arena(5, 0))).toMatchObject({ mode: 'arena', wave: 7, waveKill: 3, won: false });
  });

  it('the fight after the tenth kill of wave 10 is the boss', () => {
    expect(battle(arena(10, 10), arena(11, 0))).toMatchObject({ mode: 'arena', wave: 10, waveKill: 11, arenaBoss: true, won: true });
    expect(battle(arena(10, 10), arena(5, 0))).toMatchObject({ wave: 10, arenaBoss: true, won: false });
  });

  it('a save with nothing moved (a PvP match at the cap) makes no Arena fight', () => {
    expect(battle(arena(3, 4), arena(3, 4))).toBeUndefined();
  });
});
