import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  ELEMENTS,
  RARITIES,
  applyTurn,
  tally,
  type Element,
  type PvpFighter,
  type PvpGear,
  type PvpReplay,
  type PvpTurn,
  type Rarity,
  type SideTally,
  type TurnCounts,
} from '@shared/contracts';
import type { PvpArchive } from '../storage/pvp-archive';
import { replaysDir } from './paths';

interface RawGear {
  slotName: string;
  itemName: string;
  rarity: string;
  category: string;
}

interface RawFighter {
  name: string;
  level: number;
  characterType: number;
  maxHp: number;
  equippedItems: RawGear[] | null;
  badgeId: string;
}

interface RawReplay {
  timestampTicks: number;
  isFriendly: boolean;
  playerWon: boolean;
  player: RawFighter;
  opponent: RawFighter;
  turns: Partial<PvpTurn>[];
}

const DOTNET_EPOCH_TICKS = 621_355_968_000_000_000;

export function ticksToIso(ticks: number): string {
  return new Date((ticks - DOTNET_EPOCH_TICKS) / 10_000).toISOString();
}

function gear(raw: RawGear[] | null): PvpGear[] {
  return (raw ?? []).map((g) => ({
    slot: g.slotName ?? '',
    name: g.itemName ?? '',
    rarity: (RARITIES.includes(g.rarity as Rarity) ? g.rarity : 'Common') as Rarity,
    element: (ELEMENTS.includes(g.category as Element) ? g.category : 'Nessuna') as Element,
  }));
}

function fighter(raw: RawFighter): PvpFighter {
  return {
    name: raw?.name ?? '?',
    level: raw?.level ?? 0,
    characterType: raw?.characterType ?? 0,
    maxHp: raw?.maxHp ?? 0,
    badgeId: raw?.badgeId ?? '',
    gear: gear(raw?.equippedItems ?? null),
  };
}

function turn(raw: Partial<PvpTurn>): PvpTurn {
  return {
    playerAttacking: Boolean(raw.playerAttacking),
    damage: raw.damage ?? 0,
    crit: Boolean(raw.crit),
    parried: Boolean(raw.parried),
    healPlayer: raw.healPlayer ?? 0,
    healEnemy: raw.healEnemy ?? 0,
    counterPlayer: raw.counterPlayer ?? 0,
    counterEnemy: raw.counterEnemy ?? 0,
    suddenDeath: Boolean(raw.suddenDeath),
    hpPlayer: raw.hpPlayer ?? 0,
    hpEnemy: raw.hpEnemy ?? 0,
  };
}

/**
 * Adds one turn to a pair of tallies, from the player's point of view. `parried` on a side means
 * the *other* side parried that attack; heal/counter belong to the side that got them.
 */
// The tally moved to shared so simulated duels count turns exactly like real ones.
export { applyTurn, tally };

export function parseReplay(file: string, raw: string): PvpReplay {
  const r = JSON.parse(raw) as RawReplay;
  const log = (r.turns ?? []).map(turn);
  const { you, them } = tally(log);
  return {
    file,
    t: ticksToIso(r.timestampTicks),
    won: r.playerWon,
    friendly: r.isFriendly,
    suddenDeath: log.some((t) => t.suddenDeath),
    player: fighter(r.player),
    opponent: fighter(r.opponent),
    turns: log.length,
    you,
    them,
    log,
  };
}

/** The same replay without the turn log: what the history list and the snapshot carry. */
export function summarize(replay: PvpReplay): PvpReplay {
  const { log: _log, ...rest } = replay;
  return rest;
}

/**
 * Polls the game's Replays folder (one JSON per PvP fight it plays in the background) and hands new
 * files to the archive. The game keeps only the last 15 (ReplayStore.Prune), so the archive is what
 * makes the history complete.
 */
export class ReplayReader extends EventEmitter<{ replay: [PvpReplay]; history: [PvpReplay[]] }> {
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly archive: PvpArchive, private readonly intervalMs = 2000) {
    super();
  }

  async start(): Promise<void> {
    await this.#import(true);
    this.emit('history', this.archive.summaries());
    this.#timer = setInterval(() => void this.#import(false), this.intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #list(): string[] {
    try {
      return readdirSync(replaysDir()).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  async #import(initial: boolean): Promise<void> {
    for (const file of this.#list()) {
      const name = basename(file);
      if (this.archive.has(name)) continue;
      const replay = await this.#read(name);
      if (!replay) continue;
      this.archive.add(name, replay.raw, summarize(replay.parsed));
      if (!initial) this.emit('replay', summarize(replay.parsed));
    }
  }

  async #read(file: string): Promise<{ raw: string; parsed: PvpReplay } | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const raw = await readFile(join(replaysDir(), file), 'utf8');
        return { raw, parsed: parseReplay(file, raw) };
      } catch {
        await new Promise((r) => setTimeout(r, 300)); // still being written
      }
    }
    return null;
  }
}
