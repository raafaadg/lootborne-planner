import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PvpReplay } from '@shared/contracts';
import { parseReplay } from '../game-reader/replay-reader';

/**
 * Our own copy of every PvP replay. The game prunes its Replays folder to the last 15
 * (AutoBattle.Replay.ReplayStore.Prune), so without this the history would keep shrinking.
 *
 * userData/pvp/raw/<file>.json  the game's file, byte for byte
 * userData/pvp/index.jsonl      one summary per line (no turn log), for a fast start
 */
export class PvpArchive {
  readonly dir: string;
  readonly rawDir: string;
  readonly indexPath: string;
  #index = new Map<string, PvpReplay>();

  constructor(userData: string) {
    this.dir = join(userData, 'pvp');
    this.rawDir = join(this.dir, 'raw');
    this.indexPath = join(this.dir, 'index.jsonl');
    mkdirSync(this.rawDir, { recursive: true });
    this.#load();
  }

  #load(): void {
    let text = '';
    try {
      text = readFileSync(this.indexPath, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const replay = JSON.parse(line) as PvpReplay;
        if (replay.file) this.#index.set(replay.file, replay);
      } catch {
        // torn line after a crash
      }
    }
    // A raw file with no index line (older build, interrupted write) is re-parsed once.
    let repaired = false;
    for (const file of this.#rawFiles()) {
      if (this.#index.has(file)) continue;
      try {
        const { log: _log, ...summary } = parseReplay(file, readFileSync(join(this.rawDir, file), 'utf8'));
        this.#index.set(file, summary);
        repaired = true;
      } catch {
        // unreadable copy; skip it
      }
    }
    if (repaired) this.#rewriteIndex();
  }

  #rawFiles(): string[] {
    try {
      return readdirSync(this.rawDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  #rewriteIndex(): void {
    const lines = [...this.#index.values()].map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(this.indexPath, lines ? `${lines}\n` : '');
  }

  /**
   * Only the index counts as "we already have it". Asking the raw folder instead stranded fights:
   * `add` writes the raw copy first, so once the index append failed the file existed, `has` said
   * yes for ever and the fight never reached the history. Four of them did exactly that, including
   * the one against bajanggg.
   */
  has(file: string): boolean {
    return this.#index.has(file);
  }

  /** Stores the game's file untouched plus its summary. */
  add(file: string, raw: string, summary: PvpReplay): void {
    writeFileSync(join(this.rawDir, file), raw);
    this.#index.set(file, summary);
    try {
      appendFileSync(this.indexPath, `${JSON.stringify(summary)}\n`);
    } catch {
      // Another instance may be holding the file. The entry is already in memory, so rewrite the
      // whole index rather than dropping it.
      this.#rewriteIndex();
    }
  }

  /** Every fight we ever saw, newest first. */
  summaries(): PvpReplay[] {
    return [...this.#index.values()].sort((a, b) => b.t.localeCompare(a.t));
  }

  size(): number {
    return this.#index.size;
  }

  /** The full replay, turn log included, re-parsed from our copy. */
  detail(file: string): PvpReplay | null {
    if (!/^[\w.-]+\.json$/.test(file)) return null; // never leave the archive folder
    try {
      return parseReplay(file, readFileSync(join(this.rawDir, file), 'utf8'));
    } catch {
      return null;
    }
  }
}
