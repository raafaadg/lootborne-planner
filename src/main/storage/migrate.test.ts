import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateFromCompanion } from './migrate';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lbp-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function oldFolder(): string {
  const old = join(tmp(), 'lootborne-companion');
  mkdirSync(join(old, 'pvp', 'raw'), { recursive: true });
  mkdirSync(join(old, 'history'), { recursive: true });
  mkdirSync(join(old, 'Cache'), { recursive: true });
  writeFileSync(join(old, 'settings.json'), '{"live":{"enabled":true}}');
  writeFileSync(join(old, 'pvp', 'index.jsonl'), '{"file":"a.json"}\n');
  writeFileSync(join(old, 'pvp', 'raw', 'a.json'), '{"raw":1}');
  writeFileSync(join(old, 'history', '2026-09-23.jsonl'), '{"kind":"battle"}\n');
  writeFileSync(join(old, 'Cache', 'data_0'), 'chromium');
  return old;
}

describe('migrateFromCompanion', () => {
  it('copies our data, not Chromium caches, and leaves the old folder alone', () => {
    const old = oldFolder();
    const neu = join(tmp(), 'lootborne-planner');
    const m = migrateFromCompanion(neu, old);
    expect(m?.copied).toEqual(['settings.json', 'history', 'pvp']);
    expect(readFileSync(join(neu, 'pvp', 'raw', 'a.json'), 'utf8')).toBe('{"raw":1}');
    expect(existsSync(join(neu, 'Cache'))).toBe(false);
    // copied, never moved
    expect(existsSync(join(old, 'pvp', 'raw', 'a.json'))).toBe(true);
  });

  it('runs once', () => {
    const old = oldFolder();
    const neu = join(tmp(), 'lootborne-planner');
    expect(migrateFromCompanion(neu, old)).not.toBeNull();
    expect(migrateFromCompanion(neu, old)).toBeNull();
  });

  it('never overwrites what the new folder already has', () => {
    const old = oldFolder();
    const neu = join(tmp(), 'lootborne-planner');
    mkdirSync(neu, { recursive: true });
    writeFileSync(join(neu, 'settings.json'), '{"mine":true}');
    migrateFromCompanion(neu, old);
    expect(readFileSync(join(neu, 'settings.json'), 'utf8')).toBe('{"mine":true}');
  });

  it('does nothing without an old folder', () => {
    expect(migrateFromCompanion(join(tmp(), 'lootborne-planner'), join(tmp(), 'nope'))).toBeNull();
  });
});
