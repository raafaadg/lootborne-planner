/**
 * The optimizer's search: what it tries, what it takes, and that it never ends below its start; and
 * what one "lap" plays for each goal. The logic runs on a made-up evaluator (instant, no dice); the
 * real laps run on a small sector.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import enemies from '../../game-data/enemies.json';
import items from '../../game-data/items.json';
import sectors from '../../game-data/sectors.json';
import { sectorCategories, simulateFarm, type EnemyCategory, type SectorInfo } from './combat';
import type { CatalogItem, SaveItem, SaveState } from './contracts';
import { deepSearch, goalScore, type DeepBuild, type DeepEval, type DeepEvaluate, type DeepInput } from './deep-search';
import { deepEvaluate, type DeepContext } from './deep-eval';
import { planProfile } from './gear-advisor';
import { catalogAsItem } from './plan-eval';

const CATALOG = items as CatalogItem[];
const FIXTURE = JSON.parse(JSON.parse(readFileSync(join(__dirname, '../../fixtures/saves/plain-battle.before.json'), 'utf8')).payload) as SaveState;
const SLOTS = ['Testa', 'Corpo', 'Cintura', 'Arma 1', 'Arma 2', 'Anello 1', 'Trinket'];
const E0: DeepEval = { value: 0, margin: 0, clear: 0, depth: 0, lapSeconds: null, potionEnd: null };
let uid = 7000;
const piece = (name: string): SaveItem => ({ ...catalogAsItem(CATALOG.find((c) => c.name === name)!), uid: uid++ });

describe('the search logic', () => {
  // worn: a mixed build; spare: a Holy set whose pieces are each a little worse alone, and a strong ring
  const worn = ['Cinder Veil', "Arcanist's Robe", 'Pyre Belt', 'Flaming Axe', 'Twilight Scythe', 'Hearthfire Gauntlet', 'Dawnguard Pendant'].map(piece);
  const holy = ['Sanctified Laurel', 'Sunpenitent Raiment', 'Redemption Belt', 'Judgment Hammer', 'Faith Shield'].map(piece);
  const ring = piece('Tempest Ring');
  const bag = [...worn, ...holy, ring];
  const quality = new Map<number, number>([...worn.map((i) => [i.uid, 10] as const), ...holy.map((i) => [i.uid, 9.5] as const), [ring.uid, 12]]);
  const start: DeepBuild = { uids: worn.map((i) => i.uid), perks: [12, 5, 9, 13], alloc: { hp: 0, atk: 80, def: 85, crit: 5, parry: 80 } };
  const holyCat = holy[0]!.category;
  // a made-up build's worth: item quality, a Holy set bonus from four pieces, Baluarte (28) and DEF points
  const worth = (b: DeepBuild) => {
    let s = b.uids.reduce((a, u) => a + (quality.get(u) ?? 0), 0);
    if (b.uids.filter((u) => bag.find((i) => i.uid === u)?.category === holyCat).length >= 4) s += 8;
    if (b.perks.includes(28)) s += 3;
    return s + b.alloc.def / 10;
  };
  // and potions that pay most when drunk at enemy 30 with more doses
  const fake: DeepEvaluate = async (builds, _laps, _seed, schedule) =>
    builds.map((b): DeepEval => {
      let s = worth(b);
      if (schedule) s += schedule.doses * 1.5 - Math.abs(schedule.fromIndex - 30) / 10;
      const depth = Math.max(0, Math.min(70, s - 60));
      return { ...E0, value: depth >= 70 ? 1 : 0, clear: depth >= 70 ? 1 : 0, depth };
    });
  const input: DeepInput = { goal: 'progress', slots: SLOTS, bag, start, owned: [12, 5, 9, 13, 28, 10], points: null, schedule: null, totalEnemies: 70 };
  const total = Object.values(start.alloc).reduce((a, v) => a + v, 0);

  it('takes a whole set that no single swap would', async () => {
    const r = await deepSearch(input, fake);
    expect(r.steps.some((s) => s.kind === 'set')).toBe(true);
    // the set bonus needs four Holy pieces worn (the Dawnguard Pendant already is one)
    const holyWorn = r.end.uids.filter((u) => bag.find((i) => i.uid === u)?.category === holyCat);
    expect(holyWorn.length).toBeGreaterThanOrEqual(4);
    expect(r.end.perks).toContain(28);
    expect(goalScore('progress', r.endEval)).toBeGreaterThan(goalScore('progress', r.startEval));
  });

  it('moves points only when allowed, and then only the way that pays', async () => {
    const fixed = await deepSearch(input, fake);
    expect(fixed.end.alloc).toEqual(start.alloc);
    const zero = { hp: 0, atk: 0, def: 0, crit: 0, parry: 0 };
    const free = await deepSearch({ ...input, points: { floor: zero, total } }, fake);
    expect(free.end.alloc.def).toBeGreaterThan(start.alloc.def);
    expect(Object.values(free.end.alloc).reduce((a, v) => a + v, 0)).toBe(total);
  });

  it('places free points without taking any off the game allocation', async () => {
    const r = await deepSearch({ ...input, points: { floor: start.alloc, total: total + 25 } }, fake);
    // all 25 go to DEF, the only stat the made-up worth pays for, and nothing else moves
    expect(r.end.alloc).toEqual({ ...start.alloc, def: start.alloc.def + 25 });
    expect(r.steps.filter((s) => s.kind === 'points').every((s) => s.label.startsWith('pontos: +'))).toBe(true);
  });

  it('ranks the potion schedules, best first (progress only)', async () => {
    const r = await deepSearch({ ...input, schedule: { fromIndex: 0, doses: 1 } }, fake);
    expect(r.schedules).not.toBeNull();
    expect(r.schedules![0]).toMatchObject({ fromIndex: 30, doses: 3 });
    for (let k = 1; k < r.schedules!.length; k++) expect(goalScore('progress', r.schedules![k - 1]!)).toBeGreaterThanOrEqual(goalScore('progress', r.schedules![k]!));
    const farm = await deepSearch({ ...input, goal: 'farm', schedule: { fromIndex: 0, doses: 1 } }, async (b) => b.map((x) => ({ ...E0, value: worth(x) * 1000 })));
    expect(farm.schedules).toBeNull();
  });

  it('climbs on the goal it is given, and measures the equipped build when it starts elsewhere', async () => {
    const farmEval: DeepEvaluate = async (b) => b.map((x) => ({ ...E0, value: worth(x) * 1e4 }));
    const other = { ...start, uids: [...start.uids.slice(0, 5), ring.uid, start.uids[6]!] };
    const r = await deepSearch({ ...input, goal: 'farm', start: other, equipped: start }, farmEval);
    expect(r.equippedEval).not.toBeNull();
    expect(r.equippedEval!.value).toBe(worth(start) * 1e4);
    expect(r.endEval.value).toBeGreaterThan(r.startEval.value);
    for (const s of r.steps) expect(s.eval.value).toBeGreaterThan(0);
    // the same start and equipped build: nothing extra to measure
    const same = await deepSearch({ ...input, goal: 'farm', equipped: start }, farmEval);
    expect(same.equippedEval).toBeNull();
  });

  it('breaks a stuck win chance on the margin', async () => {
    // every build wins 100%; only the margin says the ring is better
    const pvp: DeepEvaluate = async (b) => b.map((x) => ({ ...E0, value: 1, margin: x.uids.includes(ring.uid) ? 0.5 : 0.2 }));
    const r = await deepSearch({ ...input, goal: 'pvp' }, pvp);
    expect(r.end.uids).toContain(ring.uid);
  });

  it('finds two perks that only pay together (the sweep of every loadout, for PvP)', async () => {
    // 20 and 21 are worth nothing alone and a lot together; every single swap from the start loses
    const pvp: DeepEvaluate = async (b) =>
      b.map((x) => {
        const both = x.perks.includes(20) && x.perks.includes(21);
        const lost = [12, 5, 9, 13].filter((id) => !x.perks.includes(id)).length;
        return { ...E0, value: Math.min(1, 0.5 + (both ? 0.3 : 0) - 0.02 * lost), margin: 0 };
      });
    const r = await deepSearch({ ...input, goal: 'pvp', owned: [12, 5, 9, 13, 20, 21, 28] }, pvp);
    expect(r.end.perks).toEqual(expect.arrayContaining([20, 21]));
    expect(r.steps.some((s) => s.label.startsWith('perks:'))).toBe(true);
  });

  it('tries the slot orders it is given for a set of perks', async () => {
    const seen: string[] = [];
    const pvp: DeepEvaluate = async (b) =>
      b.map((x) => {
        seen.push(x.perks.join('.'));
        // only 28 right after 12 pays
        const i = x.perks.indexOf(28);
        return { ...E0, value: i > 0 && x.perks[i - 1] === 12 ? 0.9 : 0.5 };
      });
    const orders = (set: number[]) => (set.includes(28) && set.includes(12) ? [set, [...set.filter((p) => p !== 28 && p !== 12), 12, 28]] : [set]);
    const r = await deepSearch({ ...input, goal: 'pvp', owned: [12, 5, 9, 13, 28], perkOrders: orders }, pvp);
    const i = r.end.perks.indexOf(28);
    expect(r.end.perks[i - 1]).toBe(12);
  });

  it('stops when cancelled', async () => {
    let calls = 0;
    const r = await deepSearch(input, async (b, l, s, sc) => {
      calls++;
      return fake(b, l, s, sc);
    }, { cancelled: () => calls >= 2 });
    expect(r.cancelled).toBe(true);
    expect(r.steps.length).toBeLessThanOrEqual(1);
  });
});

describe('the laps each goal plays', () => {
  const VILLAGE = (sectors as unknown as SectorInfo[])[1]!;
  const cats = sectorCategories(VILLAGE, enemies as unknown as EnemyCategory[]);
  const worn = ['Iron Helm', 'Leather Armor', 'Rope Belt', 'Rusty Sword', 'Rusty Sword', 'Copper Ring', 'Bone Charm'].map((n) => CATALOG.find((c) => c.name === n)).map((c, k) => (c ? { ...catalogAsItem(c), uid: 9000 + k } : null));
  const spare = ['Chainmail', 'Steel Helm', 'Iron Sword', 'Wooden Shield', 'Silver Ring'].map((n) => CATALOG.find((c) => c.name === n)).filter((c): c is CatalogItem => Boolean(c)).map((c, k) => ({ ...catalogAsItem(c), uid: 9100 + k }));
  const bag = [...worn.filter((i): i is SaveItem => Boolean(i)), ...spare];
  const state: SaveState = { ...FIXTURE, level: 12, inventory: bag, equippedSlots: SLOTS, equippedUids: worn.map((i) => i?.uid ?? -1), equippedPerkIds: [], allocatedHp: 20, allocatedAtk: 20, allocatedDef: 20, allocatedCrit: 0, allocatedParry: 0 };
  const base: Omit<DeepContext, 'goal'> = { state, sector: VILLAGE, cats, potions: [] };
  const start: DeepBuild = { uids: state.equippedUids, perks: [], alloc: { hp: 20, atk: 20, def: 20, crit: 0, parry: 0 } };
  const wornItems = bag.filter((i) => state.equippedUids.includes(i.uid));

  it('farm: an attempt of the farm loop; power: the formula; pvp without opponents: nothing', () => {
    const profile = planProfile(state, wornItems, [], {}).profile;
    const [farm] = deepEvaluate({ ...base, goal: 'farm' }, [start], 40, 5, null);
    expect(farm!.value).toBeCloseTo(simulateFarm(profile, VILLAGE, cats, { attempts: 40, seed: 5, playerLevel: 12 }).xpPerHour, 6);
    const [power] = deepEvaluate({ ...base, goal: 'power' }, [start], 1, 1, null);
    expect(power!.value).toBe(planProfile(state, wornItems, [], {}).build.power);
    const [pvp] = deepEvaluate({ ...base, goal: 'pvp' }, [start], 40, 1, null);
    expect(pvp!.value).toBe(0);
  });

  it('damage and survival: the sector average fight', () => {
    const [d0] = deepEvaluate({ ...base, goal: 'damage' }, [start], 40, 3, null);
    expect(d0!.value).toBeGreaterThan(0);
    const more = { ...start, alloc: { ...start.alloc, atk: 60 } };
    const [d1] = deepEvaluate({ ...base, goal: 'damage' }, [more], 40, 3, null);
    expect(d1!.value).toBeGreaterThan(d0!.value);
    const [s0] = deepEvaluate({ ...base, goal: 'survival' }, [start], 40, 3, null);
    expect(s0!.value).toBeLessThanOrEqual(0);
  });

  it('progress: the clear chance and fights won, from where the lap starts', () => {
    const [p] = deepEvaluate({ ...base, goal: 'progress' }, [start], 60, 3, null);
    expect(p!.clear).toBeGreaterThanOrEqual(0);
    expect(p!.clear).toBeLessThanOrEqual(1);
    expect(p!.depth).toBeGreaterThan(0);
    const [later] = deepEvaluate({ ...base, goal: 'progress', startIndex: VILLAGE.totalEnemies - 5 }, [start], 60, 3, null);
    expect(later!.depth).toBeLessThanOrEqual(5);
  });

  it.each(['progress', 'farm'] as const)('the search on real laps never ends below where it started (%s)', async (goal) => {
    const evaluate: DeepEvaluate = async (builds, laps, seed, schedule) => deepEvaluate({ ...base, goal }, builds, laps, seed, schedule);
    const r = await deepSearch(
      {
        goal,
        slots: SLOTS,
        bag,
        start,
        owned: [],
        points: { floor: { hp: 0, atk: 0, def: 0, crit: 0, parry: 0 }, total: 60 },
        schedule: null,
        totalEnemies: VILLAGE.totalEnemies,
        tuning: { SCREEN_LAPS: 12, CONFIRM_LAPS: 60, FINAL_LAPS: 200, MAX_ROUNDS: 3 },
      },
      evaluate,
    );
    const score = (e: DeepEval) => goalScore(goal, e);
    expect(score(r.endEval)).toBeGreaterThanOrEqual(score(r.startEval) - (goal === 'farm' ? 0.03 * Math.abs(r.startEval.value) : 1));
  }, 180_000);
});
