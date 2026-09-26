/**
 * The arena as the optimiser sees it: the opponents we were actually matched against, each one a
 * full fighter the duel simulator can replay, and our own side at the time of each fight.
 *
 * Backtested on every archived fight (src/shared/pvp-arena.test.ts has the portable part): with
 * today's build, whose stats are exact, the simulator calls 66.7% of 27 fights with a Brier score of
 * 0.206, against 0.250 for always guessing the more common outcome. The expected-value model it
 * replaced scored 48.1% and 0.377 on the same fights — worse than guessing.
 */
import type { CatalogItem, PvpReplay, PvpScouted } from './contracts';
import { elementMultiplier, type PlayerProfile } from './combat';
import type { Stats } from './game-math';
import { duelOdds, forPvp, type PvpProfile } from './duel';
import { mergePerkProcs } from './perk-mods';
import { fighterItems } from './pvp-analysis';
import { fighterModel, inferPerks, opponentModel, priorStats, type FighterModel } from './pvp-opponent';

export interface ArenaContext {
  byName: Map<string, CatalogItem>;
  /** how our points are spread (allocatedAtk/Def/Crit/Parry), for rebuilding older builds */
  split: Partial<Stats>;
  /** today's exact stats (GetTotalStats) and perks; fights fought with this build use them as is */
  today?: { stats: Stats; perkIds: number[] };
  scouts: Record<string, PvpScouted>;
}

/** Our side of an archived fight: exact if it was fought with today's build, rebuilt otherwise. */
export function ourModelAt(r: PvpReplay, ctx: ArenaContext): { model: FighterModel; today: boolean } {
  const items = fighterItems(r.player, ctx.byName);
  const today = Boolean(ctx.today && Math.abs(r.player.maxHp - ctx.today.stats.hp) <= 1);
  const inferred = r.log ? inferPerks(r.log, 'you', r.player.maxHp) : { ids: [], why: [] };
  const perks = today ? [...new Set([...ctx.today!.perkIds, ...inferred.ids])] : inferred.ids;
  const stats = today ? { ...ctx.today!.stats } : priorStats(r.player, ctx.byName, ctx.split);
  return { model: fighterModel(r.player, items, stats, perks, today ? 'jogo' : 'medido', 'inferido', inferred.why), today };
}

/** The opponent of an archived fight, measured against our side in that same fight. */
export function opponentAt(r: PvpReplay, ctx: ArenaContext, us = ourModelAt(r, ctx).model): FighterModel {
  return opponentModel({
    opponent: r.opponent,
    log: r.log ?? [],
    byName: ctx.byName,
    us: { stats: us.stats, ignoreParryPct: mergePerkProcs(us.perkIds).ignoreParryPct ?? 0, damageMult: us.profile.damageDealtMult },
    scout: ctx.scouts[r.opponent.name],
    split: ctx.split,
  });
}

export interface ArenaEntry {
  file: string;
  t: string;
  won: boolean;
  opponent: FighterModel;
}

/** The most recent ranked fights with a turn log, newest first. */
export function buildArena(replays: PvpReplay[], ctx: ArenaContext, limit = 30): ArenaEntry[] {
  return [...replays]
    .filter((r) => !r.friendly && r.log?.length)
    .sort((a, b) => b.t.localeCompare(a.t))
    .slice(0, limit)
    .map((r) => ({ file: r.file, t: r.t, won: r.won, opponent: opponentAt(r, ctx) }));
}

/** A profile from the planner, turned into an arena fighter with its perk loadout. */
export function asArenaFighter(p: PlayerProfile, perkIds: number[]): PvpProfile {
  return forPvp(p, perkIds);
}

export interface ArenaOdds {
  /** mean win chance over the opponents */
  win: number;
  perOpponent: number[];
  suddenDeath: number;
  /** mean of duelOdds.margin over the opponents */
  margin: number;
}

/**
 * Mean odds against a set of opponents. The seed is per opponent, not per call, so two builds see
 * the same dice and the difference between them is the build.
 */
export function arenaOdds(us: PvpProfile, opponents: FighterModel[], runs = 40, seed = 101): ArenaOdds {
  if (!opponents.length) return { win: 0, perOpponent: [], suddenDeath: 0, margin: 0 };
  const per = opponents.map((o, i) => {
    // a PvP boss resists or is weak to our weapons, exactly as a sector monster would be
    const mult = o.elements ? elementMultiplier(us.elementWeapons ?? [], o.elements, us.weakBothPct) : 1;
    return duelOdds(mult === 1 ? us : { ...us, damageDealtMult: us.damageDealtMult * mult }, o.profile, runs, seed + i);
  });
  return {
    win: per.reduce((a, o) => a + o.win, 0) / per.length,
    perOpponent: per.map((o) => o.win),
    suddenDeath: per.reduce((a, o) => a + o.suddenDeath, 0) / per.length,
    margin: per.reduce((a, o) => a + o.margin, 0) / per.length,
  };
}
