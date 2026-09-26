/**
 * One record per fight: the save's battle event plus what the live tap saw of the same fight
 * (mode, enemy, duration, tallies), for PvE, ranked PvP and the PvP bosses alike.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent, SaveState } from '@shared/contracts';
import { AppState } from './app-state';
import { parseSave, type SaveRead } from './game-reader/save-reader';
import { DEFAULT_SETTINGS } from './storage/settings';

const BASE = parseSave(readFileSync(join(__dirname, '../../fixtures/saves/plain-battle.before.json'), 'utf8')).state;
const save = (patch: Partial<SaveState>): SaveRead => ({ state: { ...BASE, ...patch }, path: 'save.json', mtimeMs: Date.now(), sigVersion: 8 });
const battles = (s: AppState) => s.events.filter((e): e is Extract<GameEvent, { kind: 'battle' }> => e.kind === 'battle');

// what the agent sent for real fights on 2026-09-23 (trimmed)
const PVP_START = {
  ev: 'combat_start',
  enemy: { name: 'Glen_Duval', color: 0, hp: 670, maxHp: 670, atk: 40.3, def: 161.5, crit: 14.4, parry: 45.75, level: 47, isPvP: true, isArenaBoss: false, xpWin: 40825, dropChance: 1, isFriendly: false, isBossPvp: false, bossPvpIndex: -1, isBifidus: false },
};
const PVP_END = { ev: 'combat_end', won: false, xp: 10206, isPvP: true, enemy: 'Glen_Duval', rpDelta: 0, hpLeft: 414 };
const BOSS_START = {
  ev: 'combat_start',
  enemy: { name: 'Agni Pariksha', color: 0, hp: 1805, maxHp: 1805, atk: 65.2, def: 110.9, crit: 37.9, parry: 21.3, level: 40, isPvP: true, isArenaBoss: false, xpWin: 750, dropChance: 0, isFriendly: false, isBossPvp: true, bossPvpIndex: 3, isBifidus: false },
};
const PVE_START = {
  ev: 'combat_start',
  enemy: { name: 'Deserter', color: 1, hp: 7530, maxHp: 7530, atk: 36.8, def: 74.9, crit: 18, parry: 8, level: 47, isPvP: false, isArenaBoss: false, xpWin: 36562, dropChance: 0.12 },
};
const turn = (playerAttacking: boolean, damage: number) => ({ ev: 'turn', playerAttacking, damage, crit: false, parried: false, attackerHp: 400, defenderHp: 300 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T18:17:00Z'));
});
afterEach(() => vi.useRealTimers());

function live(): AppState {
  const s = new AppState(DEFAULT_SETTINGS);
  s.onLiveStatus('live', {});
  s.onSave(save({ level: 50, xp: 1_000_000, fightsInSectorPersistent: 197, bossPvpCounter: 3, bossPvpFirstSeen: true }));
  return s;
}

describe('fights recorded with the live tap on', () => {
  it('keeps a ranked PvP match: opponent, result, duration and tallies', () => {
    const s = live();
    s.onAgentMessage(PVP_START);
    vi.advanceTimersByTime(4_000);
    s.onAgentMessage(turn(true, 20));
    s.onAgentMessage(turn(false, 35));
    vi.advanceTimersByTime(7_770);
    s.onAgentMessage(PVP_END);
    s.onSave(save({ level: 50, xp: 1_010_206, fightsInSectorPersistent: 197, bossPvpCounter: 4, bossPvpFirstSeen: true }));
    const [b] = battles(s);
    expect(b).toMatchObject({ mode: 'pvp', enemy: 'Glen_Duval', won: false, xp: 10_206, durationMs: 11_770, turns: 2, enemyLevel: 47 });
    expect(b?.you?.damage).toBe(20);
    expect(b?.them?.damage).toBe(35);
    expect(b?.enemyStats).toMatchObject({ hp: 670, atk: 40.3, parry: 45.75 });
  });

  it('labels a PvP boss by the game flag', () => {
    const s = live();
    s.onAgentMessage(BOSS_START);
    vi.advanceTimersByTime(29_600);
    s.onAgentMessage({ ev: 'combat_end', won: false, xp: 160, isPvP: true, enemy: 'Agni Pariksha', rpDelta: 0 });
    s.onSave(save({ level: 50, xp: 1_000_160, fightsInSectorPersistent: 197, bossPvpCounter: 0, bossPvpFirstSeen: true }));
    expect(battles(s)[0]).toMatchObject({ mode: 'boss', bossIndex: 3, enemy: 'Agni Pariksha', won: false, durationMs: 29_600 });
  });

  it('waits for combat_end when the save lands first', () => {
    const s = live();
    s.onAgentMessage(PVE_START);
    vi.advanceTimersByTime(25_000);
    s.onSave(save({ level: 50, xp: 1_036_562, fightsInSectorPersistent: 198, bossPvpCounter: 3, bossPvpFirstSeen: true }));
    expect(battles(s)).toHaveLength(0); // held
    vi.advanceTimersByTime(10);
    s.onAgentMessage({ ev: 'combat_end', won: true, xp: 36_562, isPvP: false, enemy: 'Deserter', rpDelta: 0 });
    expect(battles(s)[0]).toMatchObject({ mode: 'pve', enemy: 'Deserter', enemyColor: 'Blu', won: true, xp: 36_562, durationMs: 25_010 });
  });

  it('still records the fight when combat_end never comes', () => {
    const s = live();
    s.onAgentMessage(PVE_START);
    s.onSave(save({ level: 50, xp: 1_036_562, fightsInSectorPersistent: 198, bossPvpCounter: 3, bossPvpFirstSeen: true }));
    vi.advanceTimersByTime(2_000);
    expect(battles(s)[0]).toMatchObject({ mode: 'pve', xp: 36_562 });
    expect(battles(s)[0]?.enemy).toBeUndefined();
  });

  it("takes a level-up fight's XP from the tap when the diff cannot split it", () => {
    const s = live();
    s.onAgentMessage(PVP_START);
    s.onAgentMessage(PVP_END);
    s.onSave(save({ level: 51, xp: 4_116, fightsInSectorPersistent: 197, bossPvpCounter: 4, bossPvpFirstSeen: true }));
    expect(battles(s)[0]?.xp).toBe(10_206);
  });

  it('has no duration for a fight the tap joined halfway', () => {
    const s = live();
    s.onAgentMessage(turn(true, 20));
    s.onAgentMessage({ ev: 'combat_end', won: true, xp: 36_562, isPvP: false, enemy: 'Deserter', rpDelta: 0 });
    s.onSave(save({ level: 50, xp: 1_036_562, fightsInSectorPersistent: 198, bossPvpCounter: 3, bossPvpFirstSeen: true }));
    expect(battles(s)[0]?.durationMs).toBeUndefined();
    expect(battles(s)[0]?.enemy).toBe('Deserter');
  });
});

describe('fights recorded from the save alone', () => {
  it('tells PvE from PvP by fightsInSectorPersistent', () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onSave(save({ level: 50, xp: 1_000_000, fightsInSectorPersistent: 197, bossPvpCounter: 3, bossPvpFirstSeen: true }));
    s.onSave(save({ level: 50, xp: 1_027_415, fightsInSectorPersistent: 198, bossPvpCounter: 3, bossPvpFirstSeen: true }));
    s.onSave(save({ level: 50, xp: 1_037_621, fightsInSectorPersistent: 198, bossPvpCounter: 4, bossPvpFirstSeen: true }));
    expect(battles(s).map((b) => b.mode)).toEqual(['pve', 'pvp']);
  });

  it('marks the PvP fight after the counter went back to 0 as the boss of the level band', () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onSave(save({ level: 50, xp: 1_000_000, fightsInSectorPersistent: 197, bossPvpCounter: 9, bossPvpFirstSeen: true }));
    s.onSave(save({ level: 50, xp: 1_000_000, fightsInSectorPersistent: 197, bossPvpCounter: 0, bossPvpFirstSeen: true }));
    s.onSave(save({ level: 50, xp: 1_000_160, fightsInSectorPersistent: 197, bossPvpCounter: 0, bossPvpFirstSeen: true }));
    expect(battles(s)).toHaveLength(1);
    expect(battles(s)[0]).toMatchObject({ mode: 'boss', bossIndex: 3, xp: 160 });
  });

  it("splits a level-up fight's XP with the game's level curve", () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onSave(save({ level: 55, xp: 3_150_000, fightsInSectorPersistent: 197 }));
    s.onSave(save({ level: 56, xp: 20_000, fightsInSectorPersistent: 198 }));
    // XPNeededForNextLevel(55) = 3.189.242
    expect(battles(s)[0]?.xp).toBe(3_189_242 - 3_150_000 + 20_000);
  });

  it('gives a fight and its drop the same timestamp', () => {
    const s = new AppState(DEFAULT_SETTINGS);
    s.onSave(save({ fightsInSectorPersistent: 197 }));
    const item = { ...BASE.inventory[0]!, uid: 999_999 };
    s.onSave(save({ xp: BASE.xp + 100, fightsInSectorPersistent: 198, inventory: [...BASE.inventory, item] }));
    const [battle, drop] = s.events;
    expect(drop?.kind).toBe('drop');
    expect(drop?.t).toBe(battle?.t);
  });
});

describe('equipment read live', () => {
  const worn = BASE.equippedUids;
  const spare = BASE.inventory.find((i) => !worn.includes(i.uid))!;
  const player = (equipped: number[], perks: number[] = []) => ({ ev: 'player', hp: 100, stamina: 50, level: BASE.level, xp: 0, battleActive: true, screen: 4, equipped, perks });

  it('shows a swap made in the game before the save catches up', () => {
    const s = live();
    const swapped = [spare.uid, ...worn.slice(1)];
    s.onAgentMessage(player(swapped, [5, 9]));
    const view = s.snapshot().save!;
    expect(view.liveEquipment).toBe(true);
    expect(view.state.equippedUids).toEqual(swapped);
    expect(view.state.equippedPerkIds).toEqual([5, 9]);
    // the save itself is untouched: the next diff still compares save with save
    expect(s.save!.state.equippedUids).toEqual(worn);
  });

  it('ignores a reading that names an item the save has never seen', () => {
    const s = live();
    s.onAgentMessage(player([999_999, ...worn.slice(1)]));
    expect(s.snapshot().save!.liveEquipment).toBeUndefined();
  });

  it('is off without the tap', () => {
    const s = live();
    s.onAgentMessage(player([spare.uid, ...worn.slice(1)]));
    s.onLiveStatus('off', {});
    expect(s.snapshot().save!.state.equippedUids).toEqual(worn);
  });
});
