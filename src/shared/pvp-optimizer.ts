/**
 * The arena metric the build optimiser climbs.
 *
 * It used to be an expected-value comparison — damage per turn each way, survival ratio, logistic
 * curve. That model had no procs, no perks, no sudden death, and on today's build it predicted the
 * archived fights worse than a coin toss (48.1%, Brier 0.377). It is gone. The score is now the mean
 * win chance of simulated duels (duel.ts) against the opponents we were really matched with
 * (pvp-arena.ts), each with its own gear procs and its known or inferred perks.
 *
 * Both sides of every comparison face the same seeds, so a small number of fights per opponent is
 * enough to rank builds even though it is too few to quote as a precise percentage.
 */
import type { PlayerProfile } from './combat';
import { arenaOdds, asArenaFighter } from './pvp-arena';
import type { FighterModel } from './pvp-opponent';

/** Fights per opponent while searching: enough to rank, not to quote. */
export const SEARCH_RUNS = 8;
/** The arena has 16 opponents; a smaller pool (one boss) gets the same number of fights in total. */
const ARENA_SIZE = 16;

/** Fights per opponent for a pool, given the per-opponent count the full arena would use. */
export function runsFor(pool: readonly unknown[], perOpponentInArena: number): number {
  return Math.max(perOpponentInArena, Math.ceil((perOpponentInArena * ARENA_SIZE) / Math.max(1, pool.length)));
}

/** Win chance and fight margin against the pool; what the route climbs on for the fights. */
export function pvpScore(profile: PlayerProfile, perkIds: number[], pool: FighterModel[], runs = SEARCH_RUNS, seed = 101): { win: number; margin: number } {
  if (!pool.length) return { win: 0, margin: 0 };
  const o = arenaOdds(asArenaFighter(profile, perkIds), pool, runs, seed);
  return { win: o.win, margin: o.margin };
}

/** Mean win chance of this build (with this perk loadout) against the pool. 0 with no pool. */
export function pvpWinRate(profile: PlayerProfile, perkIds: number[], pool: FighterModel[], runs = SEARCH_RUNS, seed = 101): number {
  if (!pool.length) return 0;
  return arenaOdds(asArenaFighter(profile, perkIds), pool, runs, seed).win;
}
