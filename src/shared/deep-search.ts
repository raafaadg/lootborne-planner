/**
 * The optimizer: the build (and, for progress, the potion schedule) that does best at a goal,
 * searched on the Monte Carlo itself.
 *
 * It replaced a climb on the closed-form model. That one was fast and right about short fights, but
 * a poor guide in long ones: asked to clear the Cave, its "progress" route took a tank build from
 * 9.7% to 1.9%, and for the farm it put Shadow weapons on against enemies that resist Shadow. Here
 * every move is measured by playing the fights:
 *
 * - each round tries one item in one slot, the best few pairs of weapons, whole element sets (and the
 *   set leaving one slot out), one perk swapped for another, and points — free ones placed, or moved
 *   from one stat to another when the plan allows a respec;
 * - every single move is played on a dozen laps, the best 48 of them on a few dozen (the same dice for
 *   all, so they compare), the best six moves again on 300 laps with other dice, and the best of those
 *   is taken only if it beats the build it leaves, on those same 300 laps, by the goal's floor
 *   (`goalFloor`);
 * - the score is the goal's own number (`goalScore`); for progress it is 70 × the clear chance + the
 *   fights won, so a build that dies at enemy 40 still climbs towards one that dies at 55;
 * - for progress with potions that run out, the schedule is swept at the end (which enemy to drink
 *   at, 1–3 doses back to back);
 * - the start, the end and the build worn in the game are measured on 1,000 fresh laps.
 *
 * What a "lap" plays depends on the goal (deep-eval.ts). Pure and asynchronous: the laps are played by
 * `evaluate` (a pool of workers in the app, the plain simulator in tests).
 */
import { ELEMENT_NAMES, type StatKey } from './combat';
import type { SaveItem } from './contracts';
import { isShield } from './game-math';
import type { GearMetric } from './gear-advisor';

export type Alloc = Record<StatKey, number>;
export type DeepGoal = GearMetric;

export interface DeepBuild {
  /** the item worn in each slot (uid, -1 empty), in the order of `slots` */
  uids: number[];
  perks: number[];
  alloc: Alloc;
}

export interface DeepEval {
  /**
   * The goal's number: XP/h (farm), the clear chance (progress), the win chance 0–1 (pvp, boss),
   * damage per round, HP per fight (survival), PWR.
   */
  value: number;
  /** pvp and boss: how close the fights are, the tie-breaker when the wins are stuck at 0% or 100% */
  margin: number;
  /** progress and farm: the laps that clear, and the fights won per lap */
  clear: number;
  depth: number;
  /** progress: a clearing lap's length (s); null when none cleared */
  lapSeconds: number | null;
  /** progress: the enemy the potions ran out at, on average; null when they lasted */
  potionEnd: number | null;
}

export const NO_EVAL: DeepEval = { value: 0, margin: 0, clear: 0, depth: 0, lapSeconds: null, potionEnd: null };

/** When the potions go down in a lap, and how many doses back to back. */
export interface DeepSchedule {
  fromIndex: number;
  doses: number;
}

export type DeepEvaluate = (builds: DeepBuild[], laps: number, seed: number, schedule: DeepSchedule | null) => Promise<DeepEval[]>;

export interface DeepInput {
  goal: DeepGoal;
  /** slot names in the save's order ("Testa", "Arma 1" …) */
  slots: string[];
  bag: SaveItem[];
  start: DeepBuild;
  /** the build worn in the game, measured with the end when the search starts from a different plan */
  equipped?: DeepBuild;
  /** perks the player owns */
  owned: number[];
  /**
   * Points that may move: each stat stays at or above `floor` (the game's allocation, or 0 with a
   * respec) and the build holds at most `total`. null: the start's points stay.
   */
  points: { floor: Alloc; total: number } | null;
  /** progress: the plan's potion schedule; null: no potions that run out */
  schedule: DeepSchedule | null;
  totalEnemies: number;
  /** where a lap starts (progress from where the character stands) */
  startIndex?: number;
  perkName?: (id: number) => string;
  /** fewer laps or rounds (tests, a quick pass) */
  tuning?: Partial<DeepTuning>;
  /**
   * The slot orders worth trying for a set of perks. Order matters when a perk reads its neighbour
   * (Mirror Echo copies the one to its left); by default a set is tried in one order.
   */
  perkOrders?: (set: number[]) => number[][];
}

export type DeepMoveKind = 'item' | 'pair' | 'set' | 'perk' | 'points';

export interface DeepStep {
  kind: DeepMoveKind;
  label: string;
  build: DeepBuild;
  /** the build after this step, on the confirmation laps */
  eval: DeepEval;
}

export interface DeepScheduleRow extends DeepSchedule, DeepEval {}

export interface DeepProgress {
  phase: 'search' | 'perks' | 'schedule' | 'confirm';
  round: number;
  /** evaluations done / planned in this phase */
  done: number;
  total: number;
  now?: DeepEval;
  message?: string;
}

export interface DeepResult {
  goal: DeepGoal;
  steps: DeepStep[];
  start: DeepBuild;
  end: DeepBuild;
  /** both on 1,000 fresh laps (with the plan's schedule) */
  startEval: DeepEval;
  endEval: DeepEval;
  /** the build worn in the game on the same laps, when the search did not start from it */
  equippedEval: DeepEval | null;
  /** progress: the end build under each schedule, best first; null without potions that run out */
  schedules: DeepScheduleRow[] | null;
  evaluations: number;
  cancelled: boolean;
}

export interface DeepTuning {
  /** a first pass over every single move, and how many of them go on to the screen */
  PRESCREEN_LAPS: number;
  PRESCREEN_KEEP: number;
  SCREEN_LAPS: number;
  CONFIRM_LAPS: number;
  FINAL_LAPS: number;
  SCHEDULE_LAPS: number;
  CONFIRM_KEEP: number;
  MAX_ROUNDS: number;
  PAIR_KEEP: number;
  /** points moved at a time: a small step, and a long one to get far in few rounds */
  POINT_STEPS: number[];
  /** the goals cheap enough for every perk loadout to be played at the end */
  PERK_SWEEP_GOALS: DeepGoal[];
}

export const DEEP: DeepTuning = {
  /** a lap of a tank build in the Cave takes seconds to play: 250 single moves on 36 laps each were most of a round */
  PRESCREEN_LAPS: 12,
  PRESCREEN_KEEP: 48,
  /** laps per move in the sweep, and for the best six on other dice */
  SCREEN_LAPS: 36,
  CONFIRM_LAPS: 300,
  FINAL_LAPS: 1000,
  SCHEDULE_LAPS: 300,
  CONFIRM_KEEP: 6,
  MAX_ROUNDS: 12,
  /** weapons per slot that go into the pairs */
  PAIR_KEEP: 4,
  POINT_STEPS: [10, 30],
  PERK_SWEEP_GOALS: ['pvp', 'boss', 'power'],
};

/** What the search ranks by: higher is better. */
export function goalScore(goal: DeepGoal, e: DeepEval): number {
  switch (goal) {
    case 'progress':
      return 70 * e.clear + e.depth;
    case 'pvp':
    case 'boss':
      // in points of win chance; a margin 10 points better is worth one point of wins
      return 100 * (e.value + 0.1 * e.margin);
    default:
      return e.value;
  }
}

/** How much better (in `goalScore` units) a move must confirm: below it, the move is a tie or dice. */
export function goalFloor(goal: DeepGoal, base: DeepEval): number {
  switch (goal) {
    case 'progress':
      // half a fight, or 0.7 points of the clear chance
      return 0.5;
    case 'farm':
    case 'damage':
      return Math.max(1e-6, Math.abs(base.value) * 0.01);
    case 'survival':
      return Math.max(2, Math.abs(base.value) * 0.01);
    default:
      // one point of win chance, one PWR
      return 1;
  }
}

const SLOT_OF_ITEM = ['Testa', 'Corpo', 'Cintura', 'Arma', 'Anello', 'Trinket'];
const STATS: StatKey[] = ['hp', 'atk', 'def', 'crit', 'parry'];
const STAT_NAME: Record<StatKey, string> = { hp: 'HP', atk: 'ATK', def: 'DEF', crit: 'CRIT', parry: 'PARRY' };
const keyOf = (b: DeepBuild) => `${b.uids.join('.')}|${[...b.perks].sort((x, y) => x - y).join('.')}|${STATS.map((k) => b.alloc[k]).join('.')}`;
const sumOf = (a: Alloc) => STATS.reduce((s, k) => s + a[k], 0);

interface Move {
  kind: DeepMoveKind;
  label: string;
  build: DeepBuild;
  /** the slot and piece of a single-item move, for the pairs and sets */
  slotItem?: { idx: number; item: SaveItem };
}

export async function deepSearch(
  input: DeepInput,
  evaluate: DeepEvaluate,
  hooks: { progress?: (p: DeepProgress) => void; cancelled?: () => boolean; /** builds per call to `evaluate` */ chunk?: number } = {},
): Promise<DeepResult> {
  const { goal, slots, owned, totalEnemies } = input;
  const T = { ...DEEP, ...input.tuning };
  const score = (e: DeepEval) => goalScore(goal, e);
  const perkName = input.perkName ?? ((id: number) => `#${id}`);
  const byUid = new Map(input.bag.map((i) => [i.uid, i]));
  const bag = [...input.bag].sort((a, b) => a.uid - b.uid);
  const fits = (idx: number, item: SaveItem) =>
    slots[idx]!.startsWith(SLOT_OF_ITEM[item.slot as number] ?? '?') && (!isShield(item) || slots[idx] === 'Arma 2');
  const weaponIdx = slots.map((s, i) => (s.startsWith('Arma') ? i : -1)).filter((i) => i >= 0);
  const stop = () => Boolean(hooks.cancelled?.());

  let evaluations = 0;
  const cache = new Map<string, DeepEval>();
  /** measure many builds, reusing what was already played on the same dice */
  const measure = async (builds: DeepBuild[], laps: number, seed: number, schedule: DeepSchedule | null, phase: DeepProgress['phase'], round: number) => {
    const tag = `|${laps}|${seed}|${JSON.stringify(schedule)}`;
    const out: Array<DeepEval | undefined> = builds.map((b) => cache.get(keyOf(b) + tag));
    const missing = builds.map((b, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
    // in chunks, so the progress moves and a cancel lands between them
    const CHUNK = hooks.chunk ?? 24;
    for (let c = 0; c < missing.length; c += CHUNK) {
      if (stop()) break;
      const part = missing.slice(c, c + CHUNK);
      const got = await evaluate(part.map((i) => builds[i]!), laps, seed, schedule);
      part.forEach((i, k) => {
        out[i] = got[k]!;
        cache.set(keyOf(builds[i]!) + tag, got[k]!);
      });
      evaluations += part.length;
      hooks.progress?.({ phase, round, done: Math.min(missing.length, c + CHUNK), total: missing.length });
    }
    return out.map((e) => e ?? NO_EVAL);
  };

  const schedule = goal === 'progress' ? input.schedule : null;
  let cur: DeepBuild = { uids: [...input.start.uids], perks: [...input.start.perks], alloc: { ...input.start.alloc } };
  const steps: DeepStep[] = [];

  for (let round = 0; round < T.MAX_ROUNDS && !stop(); round++) {
    const seed = 101 + round;
    const inUse = new Set(cur.uids.filter((u) => u > 0 || u < -1));
    // one item, one perk, points
    const singles: Move[] = [];
    for (let idx = 0; idx < slots.length; idx++) {
      const here = byUid.get(cur.uids[idx]!);
      const seen = new Set<number>(here ? [here.templateId] : []);
      for (const it of bag) {
        if (inUse.has(it.uid) || !fits(idx, it) || seen.has(it.templateId)) continue;
        seen.add(it.templateId);
        const uids = cur.uids.slice();
        uids[idx] = it.uid;
        singles.push({ kind: 'item', label: `${slots[idx]}: ${here?.itemName ?? '—'} → ${it.itemName}`, build: { ...cur, uids }, slotItem: { idx, item: it } });
      }
    }
    for (let j = 0; j < cur.perks.length; j++) {
      for (const q of owned) {
        if (cur.perks.includes(q)) continue;
        const perks = cur.perks.slice();
        perks[j] = q;
        singles.push({ kind: 'perk', label: `perk: ${perkName(cur.perks[j]!)} → ${perkName(q)}`, build: { ...cur, perks } });
      }
    }
    if (input.points) {
      const { floor, total } = input.points;
      const free = total - sumOf(cur.alloc);
      if (free > 0) {
        const sizes = [...new Set([...T.POINT_STEPS.filter((n) => n < free), free])];
        for (const to of STATS) {
          for (const n of sizes) singles.push({ kind: 'points', label: `pontos: +${n} em ${STAT_NAME[to]}`, build: { ...cur, alloc: { ...cur.alloc, [to]: cur.alloc[to] + n } } });
        }
      }
      for (const from of STATS) {
        const movable = cur.alloc[from] - floor[from];
        if (movable <= 0) continue;
        const sizes = [...new Set(T.POINT_STEPS.map((n) => Math.min(n, movable)))];
        for (const to of STATS) {
          if (from === to) continue;
          for (const n of sizes) {
            singles.push({ kind: 'points', label: `pontos: ${n} de ${STAT_NAME[from]} para ${STAT_NAME[to]}`, build: { ...cur, alloc: { ...cur.alloc, [from]: cur.alloc[from] - n, [to]: cur.alloc[to] + n } } });
          }
        }
      }
    }
    const baseE = (await measure([cur], T.CONFIRM_LAPS, 7000 + round, schedule, 'search', round))[0]!;
    const pre = singles.length > T.PRESCREEN_KEEP && T.PRESCREEN_LAPS < T.SCREEN_LAPS;
    hooks.progress?.({
      phase: 'search',
      round,
      done: 0,
      total: singles.length,
      now: baseE,
      message: `rodada ${round + 1}: ${singles.length} trocas simples${pre ? `, as ${T.PRESCREEN_KEEP} melhores de novo em ${T.SCREEN_LAPS} voltas` : ''}`,
    });
    // every single move on a few laps, the best of them on more; the rest stay ranked by the first pass
    let first = singles.map((m) => ({ m, s: 0 }));
    let scored = first;
    if (pre) {
      const preE = await measure(singles.map((m) => m.build), T.PRESCREEN_LAPS, seed + 500, schedule, 'search', round);
      if (stop()) break;
      first = singles.map((m, i) => ({ m, s: score(preE[i]!) })).sort((a, b) => b.s - a.s);
      scored = first.slice(0, T.PRESCREEN_KEEP);
    }
    const singleE = await measure(scored.map((x) => x.m.build), T.SCREEN_LAPS, seed, schedule, 'search', round);
    if (stop()) break;
    scored = scored.map((x, i) => ({ m: x.m, s: score(singleE[i]!) }));

    // both weapons, and whole element sets, from the best single pieces of each slot
    const bySlot = new Map<number, SaveItem[]>();
    for (const { m } of [...[...scored].sort((a, b) => b.s - a.s), ...(pre ? first.slice(T.PRESCREEN_KEEP) : [])]) {
      if (m.kind !== 'item' || !m.slotItem) continue;
      const list = bySlot.get(m.slotItem.idx) ?? [];
      list.push(m.slotItem.item);
      bySlot.set(m.slotItem.idx, list);
    }
    const multi: Move[] = [];
    if (weaponIdx.length === 2) {
      const [i1, i2] = weaponIdx as [number, number];
      for (const a of (bySlot.get(i1) ?? []).slice(0, T.PAIR_KEEP)) {
        for (const b of (bySlot.get(i2) ?? []).slice(0, T.PAIR_KEEP)) {
          if (a.uid === b.uid) continue;
          const uids = cur.uids.slice();
          uids[i1] = a.uid;
          uids[i2] = b.uid;
          multi.push({ kind: 'pair', label: `armas: ${a.itemName} + ${b.itemName}`, build: { ...cur, uids } });
        }
      }
    }
    for (let el = 1; el < ELEMENT_NAMES.length; el++) {
      const taken = new Set<number>();
      const ch: Array<{ idx: number; item: SaveItem }> = [];
      for (let idx = 0; idx < slots.length; idx++) {
        if (byUid.get(cur.uids[idx]!)?.category === el) continue;
        const pick = (bySlot.get(idx) ?? []).find((c) => c.category === el && !taken.has(c.uid));
        if (!pick) continue;
        taken.add(pick.uid);
        ch.push({ idx, item: pick });
      }
      const variants = [ch, ...(ch.length >= 3 ? ch.map((_, j) => ch.filter((__, k) => k !== j)) : [])];
      for (const v of variants) {
        if (v.length < 2) continue;
        const uids = cur.uids.slice();
        for (const c of v) uids[c.idx] = c.item.uid;
        multi.push({ kind: 'set', label: `conjunto ${ELEMENT_NAMES[el]}: ${v.map((c) => `${slots[c.idx]} → ${c.item.itemName}`).join(', ')}`, build: { ...cur, uids } });
      }
    }
    const multiE = await measure(multi.map((m) => m.build), T.SCREEN_LAPS, seed, schedule, 'search', round);
    if (stop()) break;
    const all = [...scored, ...multi.map((m, i) => ({ m, s: score(multiE[i]!) }))].sort((a, b) => b.s - a.s);

    // the best few again, on other dice, against the build they leave on the same dice
    const top = all.slice(0, T.CONFIRM_KEEP);
    const topE = await measure(top.map((t) => t.m.build), T.CONFIRM_LAPS, 7000 + round, schedule, 'search', round);
    if (stop()) break;
    let best = -1;
    for (let k = 0; k < top.length; k++) if (best < 0 || score(topE[k]!) > score(topE[best]!)) best = k;
    if (best < 0 || score(topE[best]!) < score(baseE) + goalFloor(goal, baseE)) {
      hooks.progress?.({ phase: 'search', round, done: 1, total: 1, now: baseE, message: `rodada ${round + 1}: nenhuma troca melhora — fim da busca` });
      break;
    }
    const move = top[best]!.m;
    cur = move.build;
    steps.push({ kind: move.kind, label: move.label, build: cur, eval: topE[best]! });
    hooks.progress?.({ phase: 'search', round, done: 1, total: 1, now: topE[best]!, message: `rodada ${round + 1}: ${move.label}` });
  }

  // Every loadout of the owned perks on the items found. One perk at a time climbs to a loadout
  // where no single swap pays, but two perks can only pay together (a stat perk and the proc that
  // feeds on it); where fights are cheap the whole set is played.
  if (T.PERK_SWEEP_GOALS.includes(goal) && !stop() && cur.perks.length > 0 && owned.length > cur.perks.length) {
    const k = cur.perks.length;
    const sets: number[][] = [];
    const pick = (from: number, acc: number[]) => {
      if (acc.length === k) return void sets.push(acc.slice());
      for (let i = from; i < owned.length; i++) pick(i + 1, [...acc, owned[i]!]);
    };
    pick(0, []);
    const orders = input.perkOrders ?? ((set: number[]) => [set]);
    const loadouts = sets.flatMap(orders).map((perks) => ({ ...cur, perks }));
    hooks.progress?.({ phase: 'perks', round: 0, done: 0, total: loadouts.length, message: `todas as combinações de perks: ${loadouts.length}` });
    const preE = await measure(loadouts, T.PRESCREEN_LAPS, 5100, schedule, 'perks', 0);
    if (!stop()) {
      const ranked = loadouts.map((b, i) => ({ b, s: score(preE[i]!) })).sort((a, b2) => b2.s - a.s).slice(0, T.PRESCREEN_KEEP);
      const midE = await measure(ranked.map((x) => x.b), T.SCREEN_LAPS, 5200, schedule, 'perks', 0);
      const top = ranked.map((x, i) => ({ b: x.b, s: score(midE[i]!) })).sort((a, b2) => b2.s - a.s).slice(0, T.CONFIRM_KEEP);
      const [baseE, ...topE] = await measure([cur, ...top.map((x) => x.b)], T.CONFIRM_LAPS, 5300, schedule, 'perks', 0);
      let best = -1;
      for (let i = 0; i < topE.length; i++) if (best < 0 || score(topE[i]!) > score(topE[best]!)) best = i;
      if (!stop() && best >= 0 && score(topE[best]!) >= score(baseE!) + goalFloor(goal, baseE!)) {
        const from = cur.perks;
        cur = top[best]!.b;
        steps.push({ kind: 'perk', label: `perks: ${from.map(perkName).join(', ')} → ${cur.perks.map(perkName).join(', ')}`, build: cur, eval: topE[best]! });
        hooks.progress?.({ phase: 'perks', round: 0, done: 1, total: 1, now: topE[best]!, message: `perks: ${cur.perks.map(perkName).join(', ')}` });
      }
    }
  }

  // when to drink, and how many doses
  let schedules: DeepScheduleRow[] | null = null;
  if (schedule && !stop()) {
    const rows: DeepSchedule[] = [];
    const first = Math.floor((input.startIndex ?? 0) / 10) * 10;
    for (let doses = 1; doses <= 3; doses++) for (let from = first; from < totalEnemies; from += 10) rows.push({ fromIndex: from, doses });
    const got: DeepScheduleRow[] = [];
    for (let k = 0; k < rows.length && !stop(); k++) {
      const e = (await measure([cur], T.SCHEDULE_LAPS, 8000, rows[k]!, 'schedule', 0))[0]!;
      got.push({ ...rows[k]!, ...e });
      hooks.progress?.({ phase: 'schedule', round: 0, done: k + 1, total: rows.length, message: `horário das poções: ${k + 1} de ${rows.length}` });
    }
    schedules = got.sort((a, b) => score(b) - score(a) || a.doses - b.doses);
  }

  const withEquipped = input.equipped && keyOf(input.equipped) !== keyOf(input.start) ? input.equipped : null;
  hooks.progress?.({ phase: 'confirm', round: 0, done: 0, total: withEquipped ? 3 : 2, message: `conferindo em ${T.FINAL_LAPS.toLocaleString('pt-BR')} voltas` });
  const finals = await measure([input.start, cur, ...(withEquipped ? [withEquipped] : [])], T.FINAL_LAPS, 999, schedule, 'confirm', 0);
  return {
    goal,
    steps,
    start: input.start,
    end: cur,
    startEval: finals[0]!,
    endEval: finals[1]!,
    equippedEval: withEquipped ? finals[2]! : null,
    schedules,
    evaluations,
    cancelled: stop(),
  };
}
