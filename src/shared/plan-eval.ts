/**
 * One build — the equipped one, or a plan — measured the way the Simulador shows it, every number
 * from the Monte Carlo: the sector laps (clear chance, survival curve), the farm loop (XP/h), each
 * enemy's odds (and from them the damage per round and HP per fight), the arena and the boss. The
 * optimizer ranks builds on these same simulations, so what it promises is what the table shows.
 * Pure and synchronous: the renderer runs it in the worker.
 *
 * A plan is items + perks + hypothetical stat points + potions. The points go through the save's
 * allocation (so the stats and PWR include them exactly as the game would); the potions go on top
 * of the fight profile, the way ConsumableSystem applies them.
 */
import { arenaAverages, arenaBoss, arenaOdds, arenaRoster, nextArenaBossWave, simulateArena, type ArenaSimResult, type ArenaStart, type ArenaWorld } from './arena';
import { enemyOdds, currentElementMultiplier, elementMultiplier, oddsAverages, simulateFarm, simulateSector, STAT_KEYS, type EnemyCategory, type SectorInfo, type StatKey } from './combat';
import type { CatalogItem, Element, SaveItem, SaveState } from './contracts';
import { ELEMENTS, ITEM_SLOTS, RARITIES } from './contracts';
import { mergeMods, withConsumables, type Consumable } from './consumables';
import type { BuildEstimate, Stats } from './game-math';
import { planProfile, type SectorRun } from './gear-advisor';
import { pvpWinRate } from './pvp-optimizer';
import type { FighterModel } from './pvp-opponent';

export type Points = Record<StatKey, number>;
export const NO_POINTS: Points = { atk: 0, def: 0, hp: 0, crit: 0, parry: 0 };

export interface PlanBuild {
  items: SaveItem[];
  perkIds: number[];
  /** stat points on top of the ones already allocated (what-if) */
  points: Points;
  potions: Consumable[];
  /**
   * When the potions are on during a lap: drunk at enemy `fromIndex` and good for `seconds` of
   * fighting (a dose is 2 h; doses taken back to back add up). Leave it out and they last the lap.
   */
  potionWindow?: { fromIndex: number; seconds: number };
}

export interface PlanSettings {
  sector: SectorInfo;
  cats: EnemyCategory[];
  regenTable?: number[];
  weakBothPct?: number;
  perkWeights: Record<number, number>;
  runs: number;
  startIndex: number;
  /** HP the attempt starts with; null = full */
  startHp: number | null;
  pvpPool?: FighterModel[];
  pvpRuns?: number;
  /** the PvP boss of the level band, for its win chance */
  bossPool?: FighterModel[];
  bossFights?: number;
  oddsFights?: number;
  /** the Arena instead of the sector: where the run stands and how many hours to play */
  arena?: ArenaSettings;
}

export interface ArenaSettings {
  world: ArenaWorld;
  start: ArenaStart;
  hours: number;
}

export interface ArenaOutcome {
  sim: ArenaSimResult;
  /** the wave the odds are for */
  wave: number;
  /** the next wave boss still to fight, from full HP */
  boss: { wave: number; name: string; win: number; turns: number; hp: number; atk: number; def: number; resist: string; weak: string } | null;
}

export interface EnemyLine {
  name: string;
  color: 'Grigio' | 'Blu' | 'Viola';
  level: number;
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
  resist: string;
  /** a second resisted element (Black Dragon: Frost and Flame) */
  resist2?: string;
  weak: string;
  first: number;
  last: number;
  /** times it shows up in one lap, on average */
  appear: number;
  /** win chance starting at full HP */
  win: number;
  turns: number;
  /** HP gained or lost over the fight, regen included */
  hpDelta: number;
  /** DEF at which this fight stops costing HP (null: none reachable) */
  breakEvenDef: number | null;
  sustains: boolean;
}

export interface PlanOutcome {
  /** stats before potions, points included, with where each one comes from */
  build: BuildEstimate;
  /** what the fight uses: potions on top */
  fight: Stats;
  power: number;
  weapons: string[];
  elementMult: number;
  clearProb: number;
  expectedAttempts: number | null;
  /** P(still alive after enemy i), from the start index */
  survival: number[];
  avgEndHp: number;
  /** how long a lap that clears takes (seconds, the Monte Carlo's); null when none cleared */
  lapSeconds: number | null;
  /** the potion window this was measured with, and where the potions ran out on average */
  potionWindow: { fromIndex: number; seconds: number } | null;
  potionEnd: number | null;
  /** the farm loop (Monte Carlo): fight until death, restart at enemy 0 with full HP, repeat */
  run: SectorRun;
  damagePerRound: number;
  hpPerFight: number;
  /** the potions' XP bonus, already in `run` */
  xpMult: number;
  odds: EnemyLine[];
  /** mean arena win chance; null without a pool */
  pvp: number | null;
  /** win chance against the PvP boss; null without one */
  boss: number | null;
  /** what the boss's resistance / weakness does to our weapons' damage */
  bossElementMult: number | null;
  /** the Arena, when that is what was measured (then the sector numbers are empty) */
  arena: ArenaOutcome | null;
}

export function evaluatePlan(state: SaveState, b: PlanBuild, s: PlanSettings): PlanOutcome {
  const withPoints: SaveState = {
    ...state,
    allocatedHp: state.allocatedHp + b.points.hp,
    allocatedAtk: state.allocatedAtk + b.points.atk,
    allocatedDef: state.allocatedDef + b.points.def,
    allocatedCrit: state.allocatedCrit + b.points.crit,
    allocatedParry: state.allocatedParry + b.points.parry,
  };
  const perkWeight = b.perkIds.reduce((a, id) => a + (s.perkWeights[id] ?? 0), 0);
  const plan = planProfile(withPoints, b.items, b.perkIds, { perkWeight, weakBothPct: s.weakBothPct });
  const mods = mergeMods(b.potions.map((c) => c.mods));
  const profile = b.potions.length ? withConsumables(plan.profile, mods) : plan.profile;
  const xpMult = 1 + (mods.xpBonusPct ?? 0);

  if (s.arena) return evaluateArena(b, s, s.arena, plan, profile, xpMult);
  const startHp = s.startHp === null ? profile.maxHp : Math.min(profile.maxHp, s.startHp);
  // potions that run out mid-lap: the lap runs on the plain build outside their window
  const timed = b.potions.length > 0 && b.potionWindow && b.potionWindow.seconds > 0 ? b.potionWindow : null;
  const sim = timed
    ? simulateSector(plan.profile, s.sector, s.cats, { runs: s.runs, startIndex: s.startIndex, startHp, regenTable: s.regenTable, potion: { profile, ...timed } })
    : simulateSector(profile, s.sector, s.cats, { runs: s.runs, startIndex: s.startIndex, startHp, regenTable: s.regenTable });
  // the farm loop always starts at enemy 0 with full HP; a tank's attempts are long, so it plays up to
  // 20 fights per lap of the sector simulation rather than as many attempts
  const farm = simulateFarm(profile, s.sector, s.cats, { attempts: s.runs, maxFights: s.runs * 20, regenTable: s.regenTable, playerLevel: state.level });
  const run: SectorRun = {
    depth: farm.depth,
    clears: farm.clearProb >= 0.5,
    xpPerAttempt: farm.xpPerAttempt * xpMult,
    secondsPerAttempt: farm.secondsPerAttempt,
    xpPerHour: farm.xpPerHour * xpMult,
    lowestHp: 0,
    clearProb: farm.clearProb,
  };
  const rawOdds = enemyOdds(profile, s.sector, s.cats, { fights: s.oddsFights ?? 300, regenTable: s.regenTable });
  const avg = oddsAverages(rawOdds);
  const odds = rawOdds.map((o) => ({
    name: o.name,
    color: o.variant.color,
    level: o.variant.level,
    hp: o.variant.hp,
    atk: o.variant.atk,
    def: o.variant.def,
    crit: o.variant.crit,
    parry: o.variant.parry,
    resist: o.variant.resist,
    resist2: o.variant.resist2,
    weak: o.variant.weak,
    first: o.firstIndex,
    last: o.lastIndex,
    appear: o.appearProb,
    win: o.winFull,
    turns: o.avgTurns,
    hpDelta: o.hpDelta,
    breakEvenDef: o.breakEven.def,
    sustains: o.breakEven.alreadyOk,
  }));
  const pool = s.pvpPool ?? [];
  return {
    build: plan.build,
    fight: { hp: profile.maxHp, atk: profile.atk, def: profile.def, crit: profile.crit, parry: profile.parry },
    power: plan.build.power,
    weapons: profile.weaponElements,
    elementMult: currentElementMultiplier(profile, s.sector, s.cats),
    clearProb: sim.clearProb,
    expectedAttempts: sim.expectedAttempts,
    survival: sim.survival,
    avgEndHp: sim.avgEndHp,
    lapSeconds: sim.clearSeconds,
    potionWindow: timed,
    potionEnd: sim.potionEnd,
    run,
    damagePerRound: avg.damagePerRound,
    hpPerFight: avg.hpPerFight,
    xpMult,
    odds,
    // potions do not follow you into the arena: the duel uses the build alone
    pvp: pool.length ? pvpWinRate(plan.profile, b.perkIds, pool, s.pvpRuns ?? 24) : null,
    // the boss fight is a PvP fight too: no potions
    boss: s.bossPool?.length ? pvpWinRate(plan.profile, b.perkIds, s.bossPool, s.bossFights ?? 400, 7001) : null,
    bossElementMult: s.bossPool?.[0]?.elements ? elementMultiplier(plan.profile.weaponElements, s.bossPool[0].elements, plan.profile.weakBothPct) : null,
    arena: null,
  };
}

/** The same build in the Arena: hours of autofight from where the run stands, the wave's enemies and the next boss. */
function evaluateArena(b: PlanBuild, s: PlanSettings, a: ArenaSettings, plan: ReturnType<typeof planProfile>, profile: ReturnType<typeof planProfile>['profile'], xpMult: number): PlanOutcome {
  // potions go down at the start and last their doses (the Arena has no lap to place them in)
  const timed = b.potions.length > 0 && b.potionWindow && b.potionWindow.seconds > 0 ? b.potionWindow : null;
  const sim = simulateArena(timed ? plan.profile : profile, a.world, a.start, {
    // an Arena run is hours of fights: a fifth of the sector's laps gives the same spread
    runs: Math.max(100, Math.round(s.runs / 5)),
    hours: a.hours,
    ...(timed ? { potion: { profile, seconds: timed.seconds } } : {}),
  });
  const wave = Math.max(1, a.start.wave);
  const roster = arenaRoster(a.world, wave);
  const odds = arenaOdds(profile, roster, wave, s.oddsFights ?? 200);
  const avg = arenaAverages(odds);
  const bw = nextArenaBossWave(wave, a.start.bossMask);
  const bossEnemy = bw !== null ? arenaBoss(a.world, bw) : null;
  const bossOdds = bossEnemy ? arenaOdds(profile, [bossEnemy], bw!, s.bossFights ?? 200, 4411)[0]! : null;
  const weights = roster.reduce((x, e) => x + e.prob, 0) || 1;
  const pool = s.pvpPool ?? [];
  return {
    build: plan.build,
    fight: { hp: profile.maxHp, atk: profile.atk, def: profile.def, crit: profile.crit, parry: profile.parry },
    power: plan.build.power,
    weapons: profile.weaponElements,
    elementMult: roster.reduce((x, e) => x + (e.prob / weights) * elementMultiplier(profile.weaponElements, e, profile.weakBothPct, profile.ignoreResist), 0),
    clearProb: 0,
    expectedAttempts: null,
    survival: sim.reach,
    avgEndHp: 0,
    lapSeconds: null,
    potionWindow: timed,
    potionEnd: null,
    run: { depth: 0, clears: false, xpPerAttempt: 0, secondsPerAttempt: 0, xpPerHour: 0, lowestHp: 0, clearProb: 0 },
    damagePerRound: avg.damagePerRound,
    hpPerFight: avg.hpPerFight,
    xpMult,
    odds: odds.map((o) => ({
      name: o.enemy.name,
      color: o.enemy.color,
      level: o.enemy.level,
      hp: o.enemy.hp,
      atk: o.enemy.atk,
      def: o.enemy.def,
      crit: o.enemy.crit,
      parry: o.enemy.parry,
      resist: o.enemy.resist,
      weak: o.enemy.weak,
      first: wave,
      last: wave,
      // how many of the wave's 10 fights it is, on average
      appear: o.enemy.prob * 10,
      win: o.win,
      turns: o.turns,
      hpDelta: o.hpDelta,
      breakEvenDef: null,
      sustains: false,
    })),
    pvp: pool.length ? pvpWinRate(plan.profile, b.perkIds, pool, s.pvpRuns ?? 24) : null,
    boss: s.bossPool?.length ? pvpWinRate(plan.profile, b.perkIds, s.bossPool, s.bossFights ?? 400, 7001) : null,
    bossElementMult: s.bossPool?.[0]?.elements ? elementMultiplier(plan.profile.weaponElements, s.bossPool[0].elements, plan.profile.weakBothPct) : null,
    arena: {
      sim,
      wave,
      boss:
        bossEnemy && bossOdds
          ? { wave: bw!, name: bossEnemy.name, win: bossOdds.win, turns: bossOdds.turns, hp: bossEnemy.hp, atk: bossEnemy.atk, def: bossEnemy.def, resist: bossEnemy.resist, weak: bossEnemy.weak }
          : null,
    },
  };
}

/** Equal plans measure the same: a key the worker can cache the current build's outcome under. */
export function planKey(state: SaveState, b: PlanBuild, s: PlanSettings): string {
  return JSON.stringify([
    state.level,
    state.allocatedHp,
    state.allocatedAtk,
    state.allocatedDef,
    state.allocatedCrit,
    state.allocatedParry,
    b.items.map((i) => `${i.uid}:${i.templateId}`),
    b.perkIds,
    STAT_KEYS.map((k) => b.points[k]),
    b.potions.map((c) => c.id),
    b.potionWindow ?? null,
    s.sector.id,
    s.runs,
    s.startIndex,
    s.startHp,
    s.regenTable,
    s.weakBothPct,
    (s.pvpPool ?? []).length,
    s.pvpRuns,
    (s.bossPool ?? []).map((b) => b.name),
    s.arena ? [s.arena.start, s.arena.hours] : null,
  ]);
}

/**
 * A catalog item as an inventory piece, so the planner can try anything in the game. Items carry no
 * rolls (every one of the 132 in the save matched its template exactly), so the template is the
 * item. The uid is negative, and unique per slot: synergies count "other" items by uid.
 */
export function catalogAsItem(c: CatalogItem, slotIndex = 0): SaveItem {
  return {
    uid: -(c.id * 10 + slotIndex + 1),
    templateId: c.id,
    itemName: c.name,
    slot: Math.max(0, (ITEM_SLOTS as readonly string[]).indexOf(c.slot)),
    rarity: Math.max(0, RARITIES.indexOf(c.rarity)),
    category: Math.max(0, ELEMENTS.indexOf(c.element as Element)),
    hp: c.hp,
    atk: c.atk,
    def: c.def,
    crit: c.crit,
    parry: c.parry,
    effects: c.effects,
    isNew: false,
    locked: false,
    isBossExclusive: c.isBossExclusive,
    grantSource: 0,
  };
}

/** True for a piece the planner made up from the catalog rather than one in the bag. */
export const isCatalogItem = (item: Pick<SaveItem, 'uid'>) => item.uid < 0;
