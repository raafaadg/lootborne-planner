/**
 * The Arena: the endless waves that open once the last sector is cleared (PlayerState.endlessMode).
 * Recovered from CombatManager's arena methods (PickEnemyForArena, ArenaWaveScales, BuildArenaBoss,
 * ApplyBattleOutcome) and GameConstants.ARENA_*, and checked against the enemies the live tap read
 * in wave 1 (HP ×2.1792, ATK ×2.096, level +1, no resistances).
 *
 * - A wave is 10 kills. The enemy of each fight: the roster of a sector (War Camp at wave 1, drifting
 *   to the Cave by wave 50), one of its 5 categories at random (uniform), Blu or Viola (never Grigio),
 *   HP and ATK scaled by the wave, DEF / CRIT / PARRY as they are, no resistances, the weakness kept.
 * - Waves 10, 20, 30 and 40 end with a boss (once per save): full HP before it and after beating it.
 * - After a win: HP + 4% of max HP up to wave 10, 6% after (+ the items' regeneration).
 * - A death sends the run back to the last multiple of 5 below the wave (12 → 10, 10 → 5, 5 → 1), with
 *   full HP; the record (the highest wave cleared) stays.
 */
import { COMBAT, ELEMENT_NAMES, mulberry32, roundHalfEven, sectorCategories, simulateFight, type EnemyCategory, type ElementName, type PlayerProfile, type SectorEnemy, type SectorInfo } from './combat';

/** kills per wave (ARENA_ENEMIES_PER_WAVE) */
export const ARENA_ENEMIES_PER_WAVE = 10;
/** a boss every this many waves (ARENA_BOSS_EVERY_WAVES), the four of them once per save */
export const ARENA_BOSS_EVERY_WAVES = 10;
const ARENA_BOSSES = 4;
/** ARENA_BLU_PCT by loot band (waves 1–10, 11–20, 21–30, 31+); the rest is Viola */
const BLU_PCT = [0.7, 0.55, 0.35, 0.2];
/** ArenaDropChanceByColor */
export const ARENA_DROP_CHANCE = { Blu: 0.09, Viola: 0.15 } as const;
/** the drop rarity rows by loot band: Common, Rare, Epic, Legendary, Mythic (%) */
export const ARENA_DROP_RARITY = [
  [16, 28, 48, 8, 0],
  [14, 22, 48, 14, 2],
  [12, 21, 46, 17, 4],
  [10, 19, 45, 20, 6],
];
/** kills without a drop before the next one is sure (the Cave's pity) */
const PITY_KILLS = 9;
/** the wave bosses' own sheet (GameConstants.ARENA_WAVE_BOSS_*), and their elements (BossPvpEncounter) */
const BOSS_DEF = [71.3, 47.8, 95.0, 130.5];
const BOSS_CRIT = [6.7, 41.3, 19.5, 44.6];
const BOSS_PARRY = [16.2, 9.8, 16.2, 25.1];
const BOSS_RESIST = [3, 5, 4, 2];
const BOSS_WEAK = [2, 4, 5, 3];
/** ARENA_WAVE_BOSS_ANCHOR_ATK by roster sector */
const BOSS_ANCHOR_ATK = [0, 0, 0, 0, 58.94, 126.90075, 230.50999];
const BOSS_HP_FACTOR = 1.6;
const BOSS_ATK_FACTOR = 1.63;

/** HP and ATK multipliers of a wave (ArenaWaveScales; x = wave + 5) */
export function arenaScales(wave: number): { hp: number; atk: number } {
  const x = wave + 5;
  return { hp: 0.0022 * x * x + (0.1 * x + 1.5), atk: Math.fround(0.001 * x * x + (0.06 * x + 1.7)) };
}

/** Which sector's roster a wave draws from: floor(secF), or the next one with chance frac(secF). */
export function arenaSectorF(wave: number): number {
  return 4 + 2 * Math.min(1, Math.max(0, (wave - 1) / 49));
}

/** waves 1–10, 11–20, 21–30, 31+ */
export function arenaBand(wave: number): number {
  return Math.min(3, Math.max(0, Math.floor((wave - 1) / 10)));
}

export const isArenaBossWave = (wave: number) => wave > 0 && wave % ARENA_BOSS_EVERY_WAVES === 0;
export const arenaBossIndex = (wave: number) => (isArenaBossWave(wave) ? (wave / ARENA_BOSS_EVERY_WAVES - 1) % ARENA_BOSSES : -1);
/** a boss still to fight at this wave (each of the four is fought once per save) */
export function arenaBossPending(mask: number, wave: number): boolean {
  const i = arenaBossIndex(wave);
  return i >= 0 && !(mask & (1 << i));
}

/** Where a death sends the run: the last multiple of 5 strictly below the wave, never below 1. */
export function arenaCheckpoint(wave: number): number {
  let cp = Math.max(1, Math.floor(wave / 5) * 5);
  if (cp === wave) cp = Math.max(wave - 5, 1);
  return cp;
}

/** GetRegenBaselinePct in the Arena, with the wave after the win (a wave's last kill uses the next) */
export const arenaRegenPct = (wave: number) => (wave <= 10 ? 0.04 : 0.06);

export interface ArenaWorld {
  sectors: SectorInfo[];
  /** every enemy category (game-data/enemies.json) */
  cats: EnemyCategory[];
}

export interface ArenaEnemy extends SectorEnemy {
  /** the chance this one is rolled at its wave */
  prob: number;
  /** the roster sector and category it comes from */
  sector: number;
  category: EnemyCategory;
  dropChance: number;
  boss?: number;
}

const rosters = new Map<string, ArenaEnemy[]>();
/** Every enemy a normal fight of the wave can roll, with its chance and its stats at that wave. */
export function arenaRoster(world: ArenaWorld, wave: number): ArenaEnemy[] {
  const key = `${wave}|${world.sectors.length}|${world.cats.length}`;
  const hit = rosters.get(key);
  if (hit) return hit;
  const secF = arenaSectorF(wave);
  const lo = Math.min(6, Math.max(4, Math.floor(secF)));
  const last = world.sectors.length - 1;
  const sectorProbs: Array<[number, number]> = lo < 6 ? [[Math.min(lo, last), 1 - (secF - lo)], [Math.min(lo + 1, last), secF - lo]] : [[Math.min(lo, last), 1]];
  const blu = BLU_PCT[arenaBand(wave)]!;
  const { hp: hpS, atk: atkS } = arenaScales(wave);
  const out: ArenaEnemy[] = [];
  for (const [s, ps] of sectorProbs) {
    if (ps <= 0) continue;
    const cats = sectorCategories(world.sectors[s]!, world.cats);
    for (const cat of cats) {
      for (const [color, pc] of [['Blu', blu], ['Viola', 1 - blu]] as const) {
        const v = cat.variants.find((x) => x.color === color) ?? cat.variants[0]!;
        out.push({
          ...v,
          color: v.color,
          name: cat.name,
          hp: roundHalfEven(v.hp * hpS),
          atk: v.atk * atkS,
          level: v.level + Math.floor((wave + 6) / 5),
          resist: 'Nessuna',
          resist2: 'Nessuna',
          weak: cat.weak,
          prob: (ps * pc) / cats.length,
          sector: s,
          category: cat,
          dropChance: ARENA_DROP_CHANCE[color],
        });
      }
    }
  }
  rosters.set(key, out);
  return out;
}

const bosses = new Map<string, ArenaEnemy | null>();
/** The boss that ends a boss wave (BuildArenaBoss); null on other waves. */
export function arenaBoss(world: ArenaWorld, wave: number): ArenaEnemy | null {
  const bi = arenaBossIndex(wave);
  if (bi < 0) return null;
  const key = `${wave}|${world.sectors.length}|${world.cats.length}`;
  if (bosses.has(key)) return bosses.get(key)!;
  const s = Math.min(world.sectors.length - 1, Math.min(6, Math.max(4, Math.ceil(arenaSectorF(wave)))));
  const cats = sectorCategories(world.sectors[s]!, world.cats);
  const pick = (color: string | null) => {
    let hpVar: { v: EnemyCategory['variants'][number]; cat: EnemyCategory } | null = null;
    let atkVar: EnemyCategory['variants'][number] | null = null;
    for (const cat of cats)
      for (const v of cat.variants) {
        if (color && v.color !== color) continue;
        if (!hpVar || v.hp > hpVar.v.hp) hpVar = { v, cat };
        if (!atkVar || v.atk > atkVar.atk) atkVar = v;
      }
    return hpVar && atkVar ? { hpVar, atkVar } : null;
  };
  const found = pick('Viola') ?? pick(null);
  if (!found) {
    bosses.set(key, null);
    return null;
  }
  const { hp: hpS, atk: atkS } = arenaScales(wave);
  const anchor = BOSS_ANCHOR_ATK[s] ?? 0;
  const boss: ArenaEnemy = {
    ...found.hpVar.v,
    color: 'Viola',
    name: `${found.hpVar.cat.name} (boss)`,
    hp: roundHalfEven(found.hpVar.v.hp * hpS * BOSS_HP_FACTOR),
    atk: (anchor > 0 ? anchor : found.atkVar.atk) * atkS * BOSS_ATK_FACTOR,
    def: BOSS_DEF[bi]!,
    crit: Math.min(60, BOSS_CRIT[bi]!),
    parry: Math.min(55, BOSS_PARRY[bi]!),
    level: found.hpVar.v.level + Math.floor((wave + 6) / 5),
    resist: ELEMENT_NAMES[BOSS_RESIST[bi]!] as ElementName,
    resist2: 'Nessuna',
    weak: ELEMENT_NAMES[BOSS_WEAK[bi]!] as ElementName,
    prob: 1,
    sector: s,
    category: found.hpVar.cat,
    dropChance: ARENA_DROP_CHANCE.Viola,
    boss: bi,
  };
  bosses.set(key, boss);
  return boss;
}

function rollArena(world: ArenaWorld, wave: number, rng: () => number): ArenaEnemy {
  const roster = arenaRoster(world, wave);
  let r = rng();
  for (const e of roster) {
    r -= e.prob;
    if (r <= 0) return e;
  }
  return roster[roster.length - 1]!;
}

/** Where the Arena run is: the wave, the kills made in it, HP, the record and the bosses beaten. */
export interface ArenaStart {
  wave: number;
  kills: number;
  /** null: full */
  hp: number | null;
  record: number;
  bossMask: number;
  /** kills since the last drop (the pity counter) */
  pity?: number;
}

export interface ArenaSimResult {
  runs: number;
  hours: number;
  /** the waves the chart covers: `reach[i]` = P(wave `firstWave + i` cleared at least once in the time) */
  firstWave: number;
  reach: number[];
  /** the record at the end, on average (the highest wave cleared) */
  record: number;
  /** the furthest point reached, in waves (wave − 1 + kills / 10), on average: what the optimizer climbs */
  best: number;
  winsPerHour: number;
  deathsPerHour: number;
  /** the average fight (seconds) */
  fightSeconds: number;
  /** the pending wave bosses: P(beaten in the time), by wave */
  bosses: Array<{ wave: number; beaten: number }>;
  /** items per hour from kills (pity included; not the milestone and boss rewards), and by rarity (Common … Mythic) */
  itemsPerHour: number;
  rarityPerHour: number[];
}

/**
 * Hours of autofight in the Arena, in the Monte Carlo: fights until the time runs out, each death back
 * to the checkpoint with full HP. `potion` is the build with the potions on for its first `seconds`.
 */
export function simulateArena(
  p: PlayerProfile,
  world: ArenaWorld,
  start: ArenaStart,
  opts: { runs: number; hours: number; seed?: number; potion?: { profile: PlayerProfile; seconds: number } },
): ArenaSimResult {
  const rng = mulberry32(opts.seed ?? 8642);
  const budget = opts.hours * 3600;
  const first = Math.max(1, start.wave);
  const reachCount: number[] = [];
  const bossWaves = [10, 20, 30, 40].filter((w) => arenaBossPending(start.bossMask, w));
  const bossBeat = new Map<number, number>(bossWaves.map((w) => [w, 0]));
  let recordSum = 0;
  let bestSum = 0;
  let wins = 0;
  let deaths = 0;
  let fightSecs = 0;
  let fights = 0;
  let items = 0;
  const rarity = [0, 0, 0, 0, 0];
  const pot = opts.potion && opts.potion.seconds > 0 ? opts.potion : null;
  for (let run = 0; run < opts.runs; run++) {
    let t = 0;
    let w = first;
    let k = Math.min(ARENA_ENEMIES_PER_WAVE, Math.max(0, start.kills));
    let mask = start.bossMask;
    let record = start.record;
    let best = w - 1 + k / ARENA_ENEMIES_PER_WAVE;
    let pity = start.pity ?? 0;
    const prof = () => (pot && t < pot.seconds ? pot.profile : p);
    let hp = Math.min(prof().maxHp, start.hp ?? prof().maxHp);
    while (t < budget) {
      const me = prof();
      const bossFight = k >= ARENA_ENEMIES_PER_WAVE && arenaBossPending(mask, w);
      const e = bossFight ? arenaBoss(world, w)! : rollArena(world, w, rng);
      if (bossFight) hp = me.maxHp;
      const left = Math.max(1, Math.ceil((budget - t) / COMBAT.TURN_SECONDS));
      const f = simulateFight(me, hp, e, rng, left);
      t += f.seconds + COMBAT.PAUSE_SECONDS;
      fightSecs += f.seconds;
      fights++;
      if (!f.won) {
        // cut off by the clock: no progress, no death
        if (f.endHp > 0) break;
        deaths++;
        w = arenaCheckpoint(w);
        k = 0;
        hp = prof().maxHp;
        continue;
      }
      wins++;
      // the drop: pity after 9 kills without one
      if (pity >= PITY_KILLS || rng() < e.dropChance) {
        pity = 0;
        items++;
        const row = ARENA_DROP_RARITY[arenaBand(w)]!;
        for (let r = 0; r < 5; r++) rarity[r]! += row[r]! / 100;
      } else pity++;
      if (bossFight) {
        mask |= 1 << arenaBossIndex(w);
        bossBeat.set(w, (bossBeat.get(w) ?? 0) + 1);
        hp = me.maxHp;
      } else {
        hp = Math.max(1, f.endHp);
        k++;
      }
      if (k >= ARENA_ENEMIES_PER_WAVE && !arenaBossPending(mask, w)) {
        record = Math.max(record, w);
        k = 0;
        w++;
      }
      best = Math.max(best, w - 1 + k / ARENA_ENEMIES_PER_WAVE);
      const now = prof();
      hp = Math.min(now.maxHp, hp + roundHalfEven(now.maxHp * arenaRegenPct(w)) + now.regenPerFight);
    }
    recordSum += record;
    bestSum += best;
    for (let x = first; x <= record; x++) reachCount[x - first] = (reachCount[x - first] ?? 0) + 1;
  }
  const hoursPlayed = (opts.runs * budget) / 3600;
  const top = reachCount.length;
  return {
    runs: opts.runs,
    hours: opts.hours,
    firstWave: first,
    reach: Array.from({ length: Math.max(top + 2, 5) }, (_, i) => (reachCount[i] ?? 0) / opts.runs),
    record: recordSum / opts.runs,
    best: bestSum / opts.runs,
    winsPerHour: wins / hoursPlayed,
    deathsPerHour: deaths / hoursPlayed,
    fightSeconds: fights ? fightSecs / fights : 0,
    bosses: bossWaves.map((w) => ({ wave: w, beaten: (bossBeat.get(w) ?? 0) / opts.runs })),
    itemsPerHour: items / hoursPlayed,
    rarityPerHour: rarity.map((r) => r / hoursPlayed),
  };
}

export interface ArenaEnemyOdds {
  enemy: ArenaEnemy;
  /** from full HP */
  win: number;
  turns: number;
  /** HP after the fight and the Arena's regen, minus the start (−max HP on a loss) */
  hpDelta: number;
  damagePerRound: number;
}

/** Each enemy a wave can roll (or its boss), `fights` fights from full HP. */
export function arenaOdds(p: PlayerProfile, list: ArenaEnemy[], wave: number, fights: number, seed = 97531): ArenaEnemyOdds[] {
  const rng = mulberry32(seed);
  const regen = roundHalfEven(p.maxHp * arenaRegenPct(wave)) + p.regenPerFight;
  return list.map((enemy) => {
    let wins = 0;
    let turns = 0;
    let delta = 0;
    let dealt = 0;
    for (let k = 0; k < fights; k++) {
      const f = simulateFight(p, p.maxHp, enemy, rng);
      wins += f.won ? 1 : 0;
      turns += f.turns;
      delta += (f.won ? Math.min(p.maxHp, (enemy.boss !== undefined ? p.maxHp : f.endHp) + regen) : 0) - p.maxHp;
      dealt += f.dealt;
    }
    return { enemy, win: wins / fights, turns: turns / fights, hpDelta: delta / fights, damagePerRound: turns > 0 ? dealt / turns : 0 };
  });
}

/** The wave's average fight: damage per round and HP per fight, each enemy weighted by its chance. */
export function arenaAverages(odds: ArenaEnemyOdds[]): { damagePerRound: number; hpPerFight: number } {
  const total = odds.reduce((a, o) => a + o.enemy.prob, 0) || 1;
  return {
    damagePerRound: odds.reduce((a, o) => a + (o.enemy.prob / total) * o.damagePerRound, 0),
    hpPerFight: odds.reduce((a, o) => a + (o.enemy.prob / total) * o.hpDelta, 0),
  };
}

/** The next boss still to fight from this wave on (waves 10–40), or null. */
export function nextArenaBossWave(wave: number, mask: number): number | null {
  for (let w = Math.max(ARENA_BOSS_EVERY_WAVES, Math.ceil(wave / ARENA_BOSS_EVERY_WAVES) * ARENA_BOSS_EVERY_WAVES); w <= ARENA_BOSSES * ARENA_BOSS_EVERY_WAVES; w += ARENA_BOSS_EVERY_WAVES) {
    if (arenaBossPending(mask, w)) return w;
  }
  return null;
}
