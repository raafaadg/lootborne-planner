/**
 * Every fight the autofight loop ran, as one list: sector fights (PvE), the ranked PvP match it slips
 * in every few minutes, and the PvP bosses. The history only has what each source knew at the time,
 * so this joins them back up:
 *
 * - a `battle` event per fight, from the save (always) and, with the live tap on, its mode, enemy,
 *   duration and what each side did;
 * - the PvP replays (turn log, opponent gear), which the game writes for ranked matches only — the
 *   bosses leave none;
 * - for older events, written before the save diff knew PvE from PvP, the mode is recovered from the
 *   enemy name the tap merged in (PvE only), a replay at the same second (ranked PvP) or the boss XP
 *   table below (a boss pays exactly its xpWin or xpLose).
 */
import type { EnemyColor, Element, FightEnemyStats, FightMode, GameEvent, ItemRef, PvpReplay, SaveState, SideTally } from './contracts';

type BattleEvent = Extract<GameEvent, { kind: 'battle' }>;

/** An Arena enemy's name carries its wave: "Black Orc (W1)". */
export const ARENA_NAME = /\(W\d+\)$/;

/**
 * BossPvpEncounter's four bosses. Names are the `boss_pvp.N.name` strings (the same in every
 * language); stats, levels and XP are the EnemyState the live tap read in their fights (fixed per
 * boss: Agni Pariksha was identical at player levels 46 to 50); the drop is the boss-exclusive item
 * of the same element. IsBossDefeated only asks whether that item is in the inventory, and the boss
 * of your level band (the highest one whose level you have reached) keeps coming back until it is.
 */
export interface PvpBoss {
  index: number;
  name: string;
  level: number;
  stats: FightEnemyStats;
  xpWin: number;
  xpLose: number;
  element: Element;
  resist?: Element;
  weak?: Element;
  dropId: number;
  drop: string;
}

export const PVP_BOSSES: readonly PvpBoss[] = [
  { index: 0, name: 'Haru no Yuki', level: 5, stats: { hp: 894, atk: 16.2, def: 71.3, crit: 6.7, parry: 16.2 }, xpWin: 300, xpLose: 75, element: 'Frost', dropId: 421, drop: 'Frostbite Cleaver' },
  { index: 1, name: "Nero d'Inferno", level: 15, stats: { hp: 1254, atk: 31.7, def: 44, crit: 38, parry: 9 }, xpWin: 400, xpLose: 88, element: 'Shadow', dropId: 422, drop: 'Shadowfang Helm' },
  { index: 2, name: 'Carpita Claraboia', level: 25, stats: { hp: 1351, atk: 43, def: 83.6, crit: 17.2, parry: 14.3 }, xpWin: 550, xpLose: 120, element: 'Holy', resist: 'Holy', weak: 'Shadow', dropId: 423, drop: 'Dawnguard Pendant' },
  { index: 3, name: 'Agni Pariksha', level: 40, stats: { hp: 1805, atk: 65.2, def: 110.9, crit: 37.9, parry: 21.3 }, xpWin: 750, xpLose: 160, element: 'Flame', resist: 'Flame', weak: 'Frost', dropId: 424, drop: 'Emberdoom Greatsword' },
];

/** BossPvpEncounter.FirstThreshold / SubsequentThreshold: ranked matches before a boss shows up. */
export const BOSS_FIRST_THRESHOLD = 5;
export const BOSS_THRESHOLD = 10;

/**
 * From one fight's end to the next one's start the game spends ~2.4 s (median of 223 gaps the live
 * tap timed; a drop or a level-up stretches it to ~4.5 s). The save is written as a fight ends, so
 * the time between two saves is that transition plus the fight.
 */
export const TRANSITION_MS = 2_400;
/** Longer than this between two fights means a pause, a restart or the game closed: no estimate. */
export const MAX_GAP_MS = 4 * 60_000;
/** The shortest fight the tap ever timed took 6.6 s; a closer pair of saves is not two fights. */
const MIN_FIGHT_MS = 2_000;
/** A replay and the save of the same match land within a couple of seconds of each other. */
const REPLAY_MATCH_MS = 20_000;
/**
 * Two copies of the app once ran side by side and both logged every fight a few ms apart, with
 * different ids, so the history's own dedupe (identical lines) kept both. Same save, same second.
 */
const DUPLICATE_MS = 2_000;

export function bossByName(name: string | null | undefined): PvpBoss | undefined {
  return name ? PVP_BOSSES.find((b) => b.name === name) : undefined;
}

/** The boss (and outcome) a fight's XP gives away, when it is exactly a boss's xpWin or xpLose. */
export function bossByXp(xp: number): { boss: PvpBoss; won: boolean } | undefined {
  for (const boss of PVP_BOSSES) {
    if (xp === boss.xpWin) return { boss, won: true };
    if (xp === boss.xpLose) return { boss, won: false };
  }
  return undefined;
}

export interface BattleRow {
  id: string;
  t: string;
  mode: FightMode;
  /** where the mode came from: the tap saw it, the save told it, a replay matched, the boss XP, or a guess */
  modeFrom: 'live' | 'save' | 'replay' | 'xp' | 'guess';
  won: boolean | null;
  xp: number;
  enemy: string | null;
  enemyColor: EnemyColor | null;
  enemyLevel: number | null;
  boss?: PvpBoss;
  sector: number;
  enemyIndex: number;
  /** Arena: the wave and which of its kills the fight was */
  wave?: number;
  waveKill?: number;
  arenaBoss?: boolean;
  hp: [number, number];
  stamina: [number, number];
  pity: number;
  /** the fight itself: timed by the live tap, or estimated from the gap between two saves */
  durationMs: number | null;
  durationFrom: 'live' | 'gap' | null;
  turns: number | null;
  you?: SideTally;
  them?: SideTally;
  enemyStats?: FightEnemyStats;
  rpDelta?: number;
  replay?: PvpReplay;
  drops: ItemRef[];
  levelUp?: number;
  died: boolean;
  source: GameEvent['source'];
}

/**
 * Joins the history into one row per fight, oldest first. `events` must be in time order (the
 * history is); `replays` can be the archive summaries in any order.
 */
export function classifyBattles(events: GameEvent[], replays: PvpReplay[] = []): BattleRow[] {
  const byTime = [...replays].sort((a, b) => a.t.localeCompare(b.t));
  const usedReplays = new Set<string>();
  const rows: BattleRow[] = [];
  let prevBattleAt: number | null = null;
  let pausedSincePrev = false;

  // Drops, level-ups and deaths come from the same save as their fight: same timestamp.
  const sameSave = new Map<string, GameEvent[]>();
  for (const e of events) {
    if (e.kind === 'drop' || e.kind === 'level_up' || e.kind === 'death') {
      const list = sameSave.get(e.t) ?? [];
      list.push(e);
      sameSave.set(e.t, list);
    }
  }

  let prevKey = '';
  for (const e of events) {
    if (e.kind === 'battle_paused' || e.kind === 'battle_resumed' || (e.kind === 'autofight' && !e.on)) {
      pausedSincePrev = true;
      continue;
    }
    if (e.kind !== 'battle') continue;
    const at = Date.parse(e.t);
    const key = [e.xp, e.hp, e.stamina, e.sector, e.enemyIndex, e.pity].join('|');
    if (key === prevKey && prevBattleAt !== null && at - prevBattleAt < DUPLICATE_MS) continue;
    prevKey = key;
    const gap = prevBattleAt === null || pausedSincePrev ? null : at - prevBattleAt;
    prevBattleAt = at;
    pausedSincePrev = false;

    const row = baseRow(e);
    const extras = sameSave.get(e.t) ?? [];
    for (const x of extras) {
      if (x.kind === 'drop' && !row.drops.some((d) => d.uid === x.item.uid)) row.drops.push(x.item);
      else if (x.kind === 'level_up') row.levelUp = x.to;
      else if (x.kind === 'death') row.died = true;
    }
    if (row.died) row.won = false;

    classify(row, e, byTime, usedReplays);

    if (e.durationMs !== undefined) {
      row.durationMs = e.durationMs;
      row.durationFrom = 'live';
    } else if (gap !== null && gap <= MAX_GAP_MS && gap - TRANSITION_MS >= MIN_FIGHT_MS && row.mode !== 'other') {
      row.durationMs = gap - TRANSITION_MS;
      row.durationFrom = 'gap';
    }
    rows.push(row);
  }
  markOther(rows);
  return rows;
}

function baseRow(e: BattleEvent): BattleRow {
  return {
    id: e.id,
    t: e.t,
    mode: e.mode ?? 'pve',
    modeFrom: 'guess',
    won: e.won ?? null,
    xp: e.xp,
    enemy: e.enemy ?? null,
    enemyColor: e.enemyColor ?? null,
    enemyLevel: e.enemyLevel ?? null,
    sector: e.sector,
    enemyIndex: e.enemyIndex,
    ...(e.wave !== undefined ? { wave: e.wave, waveKill: e.waveKill, ...(e.arenaBoss ? { arenaBoss: true } : {}) } : {}),
    hp: e.hp,
    stamina: e.stamina,
    pity: e.pity,
    durationMs: null,
    durationFrom: null,
    turns: e.turns ?? null,
    ...(e.you ? { you: e.you } : {}),
    ...(e.them ? { them: e.them } : {}),
    ...(e.enemyStats ? { enemyStats: e.enemyStats } : {}),
    ...(e.rpDelta !== undefined ? { rpDelta: e.rpDelta } : {}),
    drops: [],
    died: false,
    source: e.source,
  };
}

function classify(row: BattleRow, e: BattleEvent, replays: PvpReplay[], used: Set<string>): void {
  const at = Date.parse(e.t);
  // 1. the live tap saw the fight (its name was merged in): the mode is the game's own flags. Before
  //    modes were recorded the tap only merged sector fights, so a named event without one is PvE.
  if (e.enemy) {
    row.modeFrom = 'live';
    const boss = bossByName(e.enemy) ?? (e.bossIndex !== undefined ? PVP_BOSSES[e.bossIndex] : undefined);
    row.mode = e.mode ?? (boss ? 'boss' : 'pve');
    if (boss && row.mode !== 'pve') applyBoss(row, boss, e.xp);
    if (row.mode === 'pvp' || row.mode === 'friendly') attachReplay(row, nearestReplay(replays, used, at, e.enemy));
    if ((row.mode === 'pve' || row.mode === 'arena') && row.won === null) row.won = true; // a PvE fight you did not die in
    return;
  }
  // 2. the save moved the sector (or the Arena's kill count): a PvE fight
  if (e.mode === 'pve' || e.mode === 'arena') {
    row.modeFrom = 'save';
    if (row.won === null) row.won = true;
    return;
  }
  // 3. a ranked match: its replay was written in the same second
  const replay = nearestReplay(replays, used, at, null);
  if (replay) {
    attachReplay(row, replay);
    row.modeFrom = 'replay';
    return;
  }
  // 4. a boss leaves no replay but pays a fixed XP
  const byXp = bossByXp(e.xp);
  if (byXp) {
    row.mode = 'boss';
    row.modeFrom = 'xp';
    applyBoss(row, byXp.boss, e.xp);
    return;
  }
  // 5. the save said "not a sector fight" and nothing else knows more; or an old event: PvE
  if (e.mode) {
    row.mode = e.mode;
    row.modeFrom = 'save';
    return;
  }
  row.mode = 'pve';
  row.modeFrom = 'guess';
  if (row.won === null) row.won = true;
}

function applyBoss(row: BattleRow, boss: PvpBoss, xp: number): void {
  row.mode = 'boss';
  row.boss = boss;
  row.enemy = boss.name;
  row.enemyLevel ??= boss.level;
  row.enemyStats ??= boss.stats;
  if (row.won === null) row.won = xp === boss.xpWin ? true : xp === boss.xpLose ? false : null;
}

function attachReplay(row: BattleRow, replay: PvpReplay | undefined): void {
  if (!replay) return;
  row.replay = replay;
  row.mode = replay.friendly ? 'friendly' : 'pvp';
  row.enemy ??= replay.opponent.name;
  row.enemyLevel ??= replay.opponent.level;
  row.won ??= replay.won;
  row.turns ??= replay.turns;
}

function nearestReplay(replays: PvpReplay[], used: Set<string>, at: number, name: string | null): PvpReplay | undefined {
  let best: PvpReplay | undefined;
  let bestDt = Infinity;
  for (const r of replays) {
    if (used.has(r.file)) continue;
    const dt = Math.abs(Date.parse(r.t) - at);
    if (dt > REPLAY_MATCH_MS) continue;
    if (name && r.opponent.name !== name) continue;
    if (dt < bestDt) {
      best = r;
      bestDt = dt;
    }
  }
  return best;
}

/**
 * XP that no fight pays: after the game was closed it credits the time away in one save, which the
 * diff sees as a "battle" with tens of fights' worth of XP. Only nameless, replay-less rows qualify.
 */
function markOther(rows: BattleRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.modeFrom !== 'guess' && r.modeFrom !== 'save') continue;
    if (r.enemy || r.replay || r.died) continue;
    const around = rows
      .slice(Math.max(0, i - 40), i + 40)
      .filter((x) => x !== r && x.mode === 'pve' && x.xp > 0)
      .map((x) => x.xp);
    const med = median(around);
    if (med > 0 && r.xp > med * 5) {
      r.mode = 'other';
      r.won = null;
      r.durationMs = null;
      r.durationFrom = null;
    }
  }
}

// ---- summaries --------------------------------------------------------------------------------

export interface DurationStats {
  /** fights with a duration (timed or estimated) */
  n: number;
  timed: number;
  avgMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  totalMs: number;
}

export interface ModeSummary {
  mode: FightMode;
  fights: number;
  wins: number;
  losses: number;
  winRate: number | null;
  xp: number;
  avgXp: number | null;
  duration: DurationStats;
  /** XP per minute spent fighting (only fights with a duration count) */
  xpPerFightMinute: number | null;
}

export function durationStats(rows: BattleRow[]): DurationStats {
  const ds = rows.map((r) => r.durationMs).filter((d): d is number => d !== null);
  const total = ds.reduce((a, b) => a + b, 0);
  return {
    n: ds.length,
    timed: rows.filter((r) => r.durationFrom === 'live').length,
    avgMs: ds.length ? total / ds.length : null,
    medianMs: ds.length ? median(ds) : null,
    minMs: ds.length ? Math.min(...ds) : null,
    maxMs: ds.length ? Math.max(...ds) : null,
    totalMs: total,
  };
}

export function summarize(rows: BattleRow[], mode: FightMode | 'all' = 'all'): ModeSummary {
  const list = mode === 'all' ? rows.filter((r) => r.mode !== 'other') : rows.filter((r) => r.mode === mode);
  const wins = list.filter((r) => r.won === true).length;
  const losses = list.filter((r) => r.won === false).length;
  const xp = list.reduce((a, r) => a + r.xp, 0);
  const withTime = list.filter((r) => r.durationMs !== null);
  const fightMin = withTime.reduce((a, r) => a + r.durationMs!, 0) / 60_000;
  return {
    mode: mode === 'all' ? 'pve' : mode,
    fights: list.length,
    wins,
    losses,
    winRate: wins + losses ? wins / (wins + losses) : null,
    xp,
    avgXp: list.length ? xp / list.length : null,
    duration: durationStats(list),
    xpPerFightMinute: fightMin > 0 ? withTime.reduce((a, r) => a + r.xp, 0) / fightMin : null,
  };
}

export interface BossRecord {
  boss: PvpBoss;
  fights: number;
  wins: number;
  losses: number;
  lastAt: string | null;
  /** you own its drop, so the game counts it as beaten (and stops sending it) */
  defeated: boolean;
  avgDurationMs: number | null;
}

export function bossRecords(rows: BattleRow[], state?: SaveState | null): BossRecord[] {
  const owned = new Set((state?.inventory ?? []).map((i) => i.templateId));
  return PVP_BOSSES.map((boss) => {
    const fights = rows.filter((r) => r.mode === 'boss' && r.boss?.index === boss.index);
    return {
      boss,
      fights: fights.length,
      wins: fights.filter((r) => r.won === true).length,
      losses: fights.filter((r) => r.won === false).length,
      lastAt: fights.at(-1)?.t ?? null,
      defeated: owned.has(boss.dropId),
      avgDurationMs: durationStats(fights).avgMs,
    };
  });
}

export interface BossForecast {
  /** the boss of your level band, or null below the first band */
  boss: PvpBoss | null;
  /** you own its drop: the game sends no boss at all until you reach the next band */
  defeated: boolean;
  /** ranked matches still to go before it shows up (it is the match right after them) */
  rankedBefore: number | null;
  threshold: number;
  counter: number;
}

/**
 * BossPvpEncounter.ShouldTrigger: the boss of your band (EligibleBossIndex: the highest boss whose
 * level you have reached — the band edges are inferred from when each one first appeared) shows up
 * when `bossPvpCounter + 1 >= threshold`, the threshold being 5 before the first boss and 10 after.
 * CountNormalPvpMatch adds one per ranked match; OnAppear puts it back to 0.
 */
export function bossForecast(state: SaveState | null | undefined): BossForecast | null {
  if (!state || typeof state.bossPvpCounter !== 'number') return null;
  let boss: PvpBoss | null = null;
  for (const b of PVP_BOSSES) if (state.level >= b.level) boss = b;
  const threshold = state.bossPvpFirstSeen ? BOSS_THRESHOLD : BOSS_FIRST_THRESHOLD;
  const counter = state.bossPvpCounter;
  const defeated = boss ? state.inventory.some((i) => i.templateId === boss!.dropId) : false;
  return {
    boss,
    defeated,
    rankedBefore: boss && !defeated ? Math.max(0, threshold - 1 - counter) : null,
    threshold,
    counter,
  };
}

/** Median time between two PvP fights (ranked or boss) over the recent ones; the loop's PvP rhythm. */
export function pvpInterval(rows: BattleRow[], last = 20): number | null {
  const times = rows.filter((r) => r.mode === 'pvp' || r.mode === 'boss').map((r) => Date.parse(r.t));
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i]! - times[i - 1]!;
    if (g > 0 && g < 30 * 60_000) gaps.push(g);
  }
  return gaps.length ? median(gaps.slice(-last)) : null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
