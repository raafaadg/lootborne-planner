import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the app keeps of its own in userData. Chromium's caches are left behind on purpose. */
const OURS = ['settings.json', 'combat.json', 'pvp-scouts.json', 'xp-table.json', 'history', 'pvp'];

const MARKER = '.migrated-from-companion';

export interface Migration {
  copied: string[];
  from: string;
}

/**
 * Lootborne Companion became Lootborne Planner, and Electron names the userData folder after the
 * app, so the new build starts in an empty %APPDATA%\lootborne-planner. The PvP archive in the old
 * folder is the only copy of every fight beyond the 15 the game keeps, so on first launch it is
 * copied across — copied, never moved: the old folder stays untouched as a backup.
 *
 * Runs once. Anything already present in the new folder wins, so a user who somehow started fresh
 * does not get their newer data overwritten.
 */
export function migrateFromCompanion(userData: string, oldUserData: string): Migration | null {
  const marker = join(userData, MARKER);
  if (existsSync(marker) || !existsSync(oldUserData)) return null;
  mkdirSync(userData, { recursive: true });
  const copied: string[] = [];
  for (const entry of OURS) {
    const from = join(oldUserData, entry);
    const to = join(userData, entry);
    if (!existsSync(from) || existsSync(to)) continue;
    cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
    copied.push(entry);
  }
  writeFileSync(marker, JSON.stringify({ from: oldUserData, at: new Date().toISOString(), copied }, null, 2));
  return { copied, from: oldUserData };
}
