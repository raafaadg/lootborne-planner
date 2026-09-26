import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeepPartial, Settings } from '@shared/contracts';

export const DEFAULT_SETTINGS: Settings = {
  live: { enabled: false },
  notify: {
    enabled: true,
    dropMinRarity: 'Rare',
    levelUp: true,
    deathStreak: 3,
    battleStalledSeconds: 120,
    inventoryNearCap: true,
    discordWebhook: '',
  },
  ui: { zoom: 1.15 },
};

export function mergeSettings<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    const current = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && current && typeof current === 'object'
        ? mergeSettings(current, v as DeepPartial<typeof current>)
        : v;
  }
  return out as T;
}

/** JSON file in the app's userData. Small, written atomically (tmp + rename). */
export class JsonStore<T> {
  readonly path: string;

  constructor(dir: string, name: string, private readonly defaults: T) {
    this.path = join(dir, name);
  }

  load(): T {
    try {
      return mergeSettings(this.defaults, JSON.parse(readFileSync(this.path, 'utf8')) as DeepPartial<T>);
    } catch {
      return this.defaults;
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, this.path);
  }
}
