import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import items from '../../game-data/items.json';
import { parseReplay } from '../main/game-reader/replay-reader';
import type { CatalogItem, PvpFighter, PvpTurn } from './contracts';
import { hitDamage, mulberry32 } from './combat';
import { POINTS_PER_LEVEL, analyzeReplay, fighterBuild, opponentRecords } from './pvp-analysis';

const BY_NAME = new Map((items as CatalogItem[]).map((i) => [i.name, i]));
const SAMPLE = parseReplay('sample.json', readFileSync(join(__dirname, '../../fixtures/replays/sample.json'), 'utf8'));

/** A fight between two known builds, so the inversion has a right answer to find. */
function synthetic(a: { atk: number; def: number; crit: number }, b: { atk: number; def: number; crit: number }, turns: number): PvpTurn[] {
  const rng = mulberry32(7);
  const out: PvpTurn[] = [];
  for (let i = 0; i < turns; i++) {
    const mine = i % 2 === 0;
    const [att, dfn] = mine ? [a, b] : [b, a];
    const crit = rng() * 100 < att.crit;
    const damage = hitDamage(att.atk, dfn.def, crit, 0.8 + rng() * 0.4);
    out.push({
      playerAttacking: mine,
      damage,
      crit,
      parried: false,
      healPlayer: 0,
      healEnemy: 0,
      counterPlayer: 0,
      counterEnemy: 0,
      suddenDeath: false,
      hpPlayer: 1000,
      hpEnemy: 1000,
    });
  }
  return out;
}

const NAKED: PvpFighter = { name: 'x', level: 21, characterType: 0, maxHp: 500, badgeId: '', gear: [] };

describe('inverting the damage formula', () => {
  it('recovers the opponent ATK and DEF when our own stats are known', () => {
    const me = { atk: 30, def: 100, crit: 18 };
    const foe = { atk: 45, def: 60, crit: 12 };
    const a = analyzeReplay({ ...NAKED, name: 'me' }, { ...NAKED, name: 'foe' }, synthetic(me, foe, 400), {
      byName: BY_NAME,
      playerStats: { hp: 500, atk: me.atk, def: me.def, crit: me.crit, parry: 0 },
    });
    expect(a.exactPlayerStats).toBe(true);
    // the damage roll is uniform, so a few hundred hits pin the mean down to a couple of percent
    expect(a.them.measured.atk!).toBeGreaterThan(foe.atk * 0.95);
    expect(a.them.measured.atk!).toBeLessThan(foe.atk * 1.05);
    expect(a.them.measured.def!).toBeGreaterThan(foe.def * 0.9);
    expect(a.them.measured.def!).toBeLessThan(foe.def * 1.1);
    // the measured crit rate lands on the real one
    expect(a.them.measured.critPct!).toBeGreaterThan(foe.crit - 6);
    expect(a.them.measured.critPct!).toBeLessThan(foe.crit + 6);
  });

  it('the margin covers the error it reports', () => {
    const me = { atk: 30, def: 100, crit: 0 };
    const foe = { atk: 45, def: 60, crit: 0 };
    const a = analyzeReplay(NAKED, NAKED, synthetic(me, foe, 60), {
      byName: BY_NAME,
      playerStats: { hp: 500, atk: me.atk, def: me.def, crit: me.crit, parry: 0 },
    });
    const m = a.them.measured;
    expect(Math.abs(m.atk! - foe.atk)).toBeLessThan(3 * m.atkMargin);
    expect(m.atkMargin).toBeGreaterThan(0);
  });

  it('counts parries as the defender stat and heals per landed hit', () => {
    const turns = synthetic({ atk: 30, def: 50, crit: 0 }, { atk: 30, def: 50, crit: 0 }, 20);
    turns[1]!.parried = true; // an attack of theirs that we parried
    turns[0]!.healPlayer = 3;
    const a = analyzeReplay(NAKED, NAKED, turns, { byName: BY_NAME });
    expect(a.you.measured.parryPct).toBeCloseTo(10, 5); // 1 of their 10 attacks
    expect(a.you.measured.healPerHit).toBeCloseTo(3 / 10, 5);
  });
});

describe('the gear of a real replay', () => {
  it('resolves every piece through the catalog', () => {
    const build = fighterBuild(SAMPLE.opponent, BY_NAME);
    expect(build.pieces.length).toBeGreaterThan(0);
    expect(build.unknown).toBe(0);
    expect(build.gear.hp).toBeGreaterThan(400);
    expect(build.weapons.length).toBeGreaterThan(0);
  });

  it('the level pays for the HP the replay records', () => {
    const build = fighterBuild(SAMPLE.opponent, BY_NAME);
    expect(build.points).toBe((SAMPLE.opponent.level - 1) * POINTS_PER_LEVEL);
    expect(build.hpPoints).toBeGreaterThanOrEqual(0);
    expect(build.hpPoints).toBeLessThanOrEqual(build.points);
  });

  it('measures both sides of the fight', () => {
    const a = analyzeReplay(SAMPLE.player, SAMPLE.opponent, SAMPLE.log!, { byName: BY_NAME });
    expect(a.them.measured.landed).toBeGreaterThan(0);
    expect(a.them.measured.meanHit).toBeGreaterThan(0);
    expect(a.them.power).toBeGreaterThan(0);
  });
});

describe('head-to-head records', () => {
  it('groups fights by opponent and keeps the latest level', () => {
    const recs = opponentRecords([
      { opponent: { name: 'a', level: 10, maxHp: 500 }, won: true, friendly: false, t: '2026-09-01T00:00:00Z' },
      { opponent: { name: 'a', level: 12, maxHp: 520 }, won: false, friendly: false, t: '2026-09-02T00:00:00Z' },
      { opponent: { name: 'b', level: 9, maxHp: 400 }, won: true, friendly: true, t: '2026-09-03T00:00:00Z' },
    ]);
    expect(recs[0]!.name).toBe('a');
    expect(recs[0]!.fights).toBe(2);
    expect(recs[0]!.wins).toBe(1);
    expect(recs[0]!.lastLevel).toBe(12);
    expect(recs[1]!.friendly).toBe(1);
  });
});
