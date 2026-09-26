import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Unity persistentDataPath for Lootborne (Application.companyName / productName). */
export function gameDataDir(): string {
  return process.env.LBP_GAME_DATA_DIR ?? join(homedir(), 'AppData', 'LocalLow', 'Turbolento Games', 'Lootborne');
}

export function replaysDir(): string {
  return join(gameDataDir(), 'Replays');
}

/** The newest `save_<steamid>_game.json` (one per Steam account). */
export function findSavePath(): string | null {
  let best: { path: string; mtime: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(gameDataDir());
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^save_\d+_game\.json$/.test(name)) continue;
    const path = join(gameDataDir(), name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      // rotated away between readdir and stat
    }
  }
  return best?.path ?? null;
}
