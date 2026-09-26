import { GRANT_SOURCES, type GameEvent, type ItemRef, type SaveItem, type SaveState } from '@shared/contracts';
import { ARENA_ENEMIES_PER_WAVE } from '@shared/arena';
import { rarityName } from '@shared/game-math';

export type NewEvent = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, 'id' | 't' | 'source'> : never) : never;

export function itemRef(item: SaveItem): ItemRef {
  return {
    uid: item.uid,
    templateId: item.templateId,
    name: item.itemName,
    slot: item.slot,
    rarity: rarityName(item.rarity),
    grantSource: GRANT_SOURCES[item.grantSource] ?? String(item.grantSource),
  };
}

/** Events implied by two consecutive saves (pure; the reader and the tests share it). */
export function diffSaves(prev: SaveState, next: SaveState): NewEvent[] {
  const out: NewEvent[] = [];
  const died = next.deathsInSectorPersistent > prev.deathsInSectorPersistent && next.currentSector === prev.currentSector;
  const sectorChanged = next.currentSector !== prev.currentSector;
  const fought =
    next.fightsInSectorPersistent !== prev.fightsInSectorPersistent || next.xp !== prev.xp || next.level !== prev.level;

  // The Arena moves neither the sector nor (at the level cap) the XP: its fights show in the wave and
  // the kill count. Forward is a win; back (a death sends the run to the last multiple of 5) is a
  // loss. The boss of waves 10–40 is an 11th fight after the 10 kills, and not counted as one.
  const kills = (s: SaveState) => s.waveKillCount ?? 0;
  const arena = prev.endlessMode && next.endlessMode && (next.waveIndex !== prev.waveIndex || kills(next) !== kills(prev));
  if (arena) {
    const won = next.waveIndex > prev.waveIndex || (next.waveIndex === prev.waveIndex && kills(next) > kills(prev));
    out.push({
      kind: 'battle',
      xp: next.level === prev.level ? Math.max(0, next.xp - prev.xp) : 0,
      hp: [prev.currentHp, next.currentHp],
      stamina: [round(prev.stamina), round(next.stamina)],
      sector: next.currentSector,
      enemyIndex: next.sectorEnemy,
      pity: next.killsWithoutDrop,
      mode: 'arena',
      wave: prev.waveIndex,
      waveKill: kills(prev) + 1,
      ...(kills(prev) >= ARENA_ENEMIES_PER_WAVE ? { arenaBoss: true } : {}),
      won,
    });
  } else if (fought || died) {
    // A sector fight always moves fightsInSectorPersistent (deaths included) and a clear moves the
    // sector; a PvP match touches neither. Which PvP (ranked or a boss) is left to the live tap, or
    // to the boss XP table (battles.ts) when the tap was off.
    const pve = died || sectorChanged || next.fightsInSectorPersistent !== prev.fightsInSectorPersistent;
    out.push({
      kind: 'battle',
      xp: next.level === prev.level ? Math.max(0, next.xp - prev.xp) : 0,
      hp: [prev.currentHp, next.currentHp],
      stamina: [round(prev.stamina), round(next.stamina)],
      sector: next.currentSector,
      enemyIndex: next.sectorEnemy,
      pity: next.killsWithoutDrop,
      mode: pve ? 'pve' : 'pvp',
      ...(died ? { won: false } : {}),
    });
  }
  if (next.level > prev.level) {
    out.push({ kind: 'level_up', from: prev.level, to: next.level, unspent: next.unspentStatPoints });
  } else if (next.unspentStatPoints > prev.unspentStatPoints) {
    out.push({ kind: 'stat_points', unspent: next.unspentStatPoints });
  }
  if (died) {
    out.push({ kind: 'death', sector: next.currentSector, deathsInSector: next.deathsInSectorPersistent });
  }
  if (sectorChanged) {
    const cleared = Boolean(next.sectorCleared[prev.currentSector]) && !prev.sectorCleared[prev.currentSector];
    out.push({ kind: 'sector_change', from: prev.currentSector, to: next.currentSector, cleared });
  }
  if (next.battleActive !== prev.battleActive) {
    const payload = { hp: next.currentHp, stamina: round(next.stamina) };
    out.push(next.battleActive ? { kind: 'battle_resumed', ...payload } : { kind: 'battle_paused', ...payload });
  }

  const before = new Map(prev.inventory.map((i) => [i.uid, i]));
  const after = new Map(next.inventory.map((i) => [i.uid, i]));
  for (const [uid, item] of after) if (!before.has(uid)) out.push({ kind: 'drop', item: itemRef(item) });
  const removed = [...before].filter(([uid]) => !after.has(uid)).map(([, item]) => itemRef(item));
  if (removed.length) out.push({ kind: 'item_removed', items: removed });
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
