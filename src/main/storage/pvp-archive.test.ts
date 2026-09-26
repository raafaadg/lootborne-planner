import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PvpArchive } from './pvp-archive';
import type { PvpReplay } from '@shared/contracts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lbp-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const summary = (file: string, name = 'foe'): PvpReplay =>
  ({ file, t: '2026-09-23T13:29:58.676Z', won: false, friendly: false, suddenDeath: false,
     player: { name: 'me', level: 46, characterType: 0, maxHp: 643, badgeId: '', gear: [] },
     opponent: { name, level: 50, characterType: 0, maxHp: 761, badgeId: '', gear: [] },
     turns: 110,
     you: { attacks: 55, landed: 17, crits: 9, parried: 38, damage: 551, best: 68, heal: 160, counter: 0 },
     them: { attacks: 55, landed: 31, crits: 25, parried: 24, damage: 623, best: 29, heal: 242, counter: 277 } }) as PvpReplay;

describe('PvpArchive', () => {
  it('stores a fight in both the raw folder and the index', () => {
    const d = tmp();
    const a = new PvpArchive(d);
    a.add('f1.json', '{"raw":1}', summary('f1.json'));
    expect(a.has('f1.json')).toBe(true);
    expect(a.summaries()).toHaveLength(1);
    expect(existsSync(join(d, 'pvp', 'raw', 'f1.json'))).toBe(true);
    expect(readFileSync(join(d, 'pvp', 'index.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('does not consider a raw copy with no index line as "have it"', () => {
    // exactly the state four fights were stranded in: raw written, index append lost
    const d = tmp();
    const a1 = new PvpArchive(d);
    writeFileSync(join(d, 'pvp', 'raw', 'orphan.json'), '{"raw":1}');
    expect(a1.has('orphan.json')).toBe(false);
  });

  it('re-indexes a stranded raw copy on the next start', () => {
    const d = tmp();
    const a = new PvpArchive(d);
    a.add('f1.json', JSON.stringify({ version: 1, isFriendly: false, timestampTicks: 639257669986764007, playerWon: false,
      player: { name: 'me', level: 46, characterType: 0, maxHp: 643, badgeId: '', equippedItems: [] },
      opponent: { name: 'bajanggg', level: 50, characterType: 0, maxHp: 761, badgeId: '', equippedItems: [] },
      turns: [] }), summary('f1.json', 'bajanggg'));
    // wipe the index but keep the raw copy, then reopen
    writeFileSync(join(d, 'pvp', 'index.jsonl'), '');
    const again = new PvpArchive(d);
    expect(again.has('f1.json')).toBe(true);
    expect(again.summaries()[0]?.opponent.name).toBe('bajanggg');
  });

  it('refuses to read outside the archive folder', () => {
    const a = new PvpArchive(tmp());
    expect(a.detail('../../../etc/passwd')).toBeNull();
    expect(a.detail('..\secrets.json')).toBeNull();
  });
});
