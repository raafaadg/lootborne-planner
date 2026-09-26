/**
 * How far the level cap is, and how long the current farm takes to get there.
 *
 * XP left divided by today's XP/h is wrong twice over: every level's bar is longer, and the farm pays
 * less at every level. The over-level penalty takes 12 points a level off every PvE enemy (counted
 * from the sector's intended level, so a sector we have outgrown fades out entirely), while PvP pays
 * more (a win is XpBaseAtLevel of our own level). So the fights of the last hour are re-priced at each
 * level ahead: the same enemies, at the same pace, paid what they would pay at that level.
 */
import type { BattleRow } from './battles';
import { sectorIntendedLevel, xpMultiplier } from './combat';
import { MAX_LEVEL, xpBaseAtLevel, xpNeededForNextLevel } from './game-math';

export const ETA_WINDOW_MS = 60 * 60_000;
/** Below this the window is a handful of fights: no rate. */
export const ETA_MIN_SPAN_MS = 10 * 60_000;

export interface EtaStep {
  level: number;
  /** XP to bank at this level (the rest of the bar for the current one) */
  xpLeft: number;
  pvePerHour: number;
  /** PvP, the PvP bosses and friendlies */
  pvpPerHour: number;
  /** null when nothing pays at this level */
  hours: number | null;
}

export interface LevelEta {
  level: number;
  target: number;
  xpLeft: number;
  /** the whole way, level by level at the re-priced rates; null without a rate or when a level pays nothing */
  hours: number | null;
  /** today's rate, and what dividing by it would say */
  perHour: number | null;
  flatHours: number | null;
  steps: EtaStep[];
  spanMs: number;
  fights: number;
  /** PvE share of today's XP */
  pveShare: number;
  /** the sector the window's PvE was fought in (the latest) */
  sector: number | null;
}

/** What one fight of the window would pay at `level`. */
function repriced(r: BattleRow, fightLevel: number, level: number): number {
  if (r.xp <= 0) return 0;
  if (r.mode === 'pve') {
    const enemyLevel = r.enemyLevel ?? sectorIntendedLevel(r.sector);
    const then = xpMultiplier(fightLevel, enemyLevel, r.sector);
    return then > 0 ? (r.xp * xpMultiplier(level, enemyLevel, r.sector)) / then : r.xp;
  }
  if (r.mode === 'pvp') return (r.xp * xpBaseAtLevel(level)) / xpBaseAtLevel(fightLevel);
  // the bosses pay a fixed amount; friendlies pay what they pay
  return r.xp;
}

export function levelEta(
  rows: BattleRow[],
  o: { level: number; xp: number; now: number; since?: string | number; windowMs?: number; neededNow?: number; target?: number },
): LevelEta {
  const target = o.target ?? MAX_LEVEL;
  const since = o.since === undefined ? -Infinity : typeof o.since === 'number' ? o.since : Date.parse(o.since);
  const start = Math.max(since, o.now - (o.windowMs ?? ETA_WINDOW_MS));
  const spanMs = Math.max(0, o.now - start);

  // newest first, walking the level back down across the level-ups
  const window: Array<{ r: BattleRow; at: number }> = [];
  let lvl = o.level;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (Date.parse(r.t) < start) break;
    if (r.levelUp !== undefined) lvl = r.levelUp - 1;
    if (r.mode === 'other') continue; // offline credit, not the farm
    window.push({ r, at: lvl });
  }
  const sector = window.find((w) => w.r.mode === 'pve')?.r.sector ?? null;
  const rated = spanMs >= ETA_MIN_SPAN_MS && window.length > 0;
  const hoursOf = spanMs / 3_600_000;

  const rateAt = (level: number) => {
    let pve = 0;
    let pvp = 0;
    for (const { r, at } of window) {
      const x = repriced(r, at, level);
      if (r.mode === 'pve') pve += x;
      else pvp += x;
    }
    return { pve: rated ? pve / hoursOf : 0, pvp: rated ? pvp / hoursOf : 0 };
  };

  const steps: EtaStep[] = [];
  let xpLeft = 0;
  let hours: number | null = rated ? 0 : null;
  for (let l = o.level; l < target; l++) {
    const bar = l === o.level ? (o.neededNow ?? xpNeededForNextLevel(l)) : xpNeededForNextLevel(l);
    const left = Math.max(0, l === o.level ? bar - o.xp : bar);
    const { pve, pvp } = rateAt(l);
    const rate = pve + pvp;
    const h = rated && rate > 0 ? left / rate : null;
    steps.push({ level: l, xpLeft: left, pvePerHour: pve, pvpPerHour: pvp, hours: h });
    xpLeft += left;
    hours = hours === null || h === null ? null : hours + h;
  }
  const now = steps[0];
  const perHour = rated && now ? now.pvePerHour + now.pvpPerHour : null;
  return {
    level: o.level,
    target,
    xpLeft,
    hours,
    perHour,
    flatHours: perHour ? xpLeft / perHour : null,
    steps,
    spanMs,
    fights: window.length,
    pveShare: perHour ? now!.pvePerHour / perHour : 0,
    sector,
  };
}

/** What the PvE of `sector` pays at `level`, for the enemies at the sector's intended level (its weakest). */
export function sectorPayAt(sector: number, level: number): number {
  return xpMultiplier(level, sectorIntendedLevel(sector), sector);
}
