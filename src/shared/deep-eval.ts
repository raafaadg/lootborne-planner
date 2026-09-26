/**
 * Plays the laps for the optimizer: a build (items per slot, perks, points) laid on the save, measured
 * for one goal. The worker pool runs it in the app; the tests call it directly.
 *
 * What one "lap" plays, per goal (the search asks for 36, 300 and 1,000 of them):
 * - progress: a lap of the sector from where the plan starts, the potions on for the whole lap or in
 *   the window of a schedule;
 * - farm: an attempt of the farm loop (enemy 0, full HP, until death or the end), potions on;
 * - damage, survival: half a fight against every enemy the sector rolls, from full HP, potions on;
 * - pvp: half a fight against each arena opponent; boss: the same number of fights against the boss
 *   (no potions in either: they do not follow you into the arena);
 * - power: nothing to play, the game's formula.
 * In the Arena, progress is one run of the chosen hours (deaths back to the checkpoint), scored by how
 * far it got in kills; damage and survival fight the enemies of the wave the run is on.
 */
import { arenaAverages, arenaOdds, arenaRoster, simulateArena } from './arena';
import { sectorFights, simulateFarm, simulateSector, type EnemyCategory, type SectorInfo } from './combat';
import type { SaveState } from './contracts';
import { mergeMods, withConsumables, type Consumable } from './consumables';
import type { DeepBuild, DeepEval, DeepGoal, DeepSchedule } from './deep-search';
import { planProfile } from './gear-advisor';
import type { ArenaSettings } from './plan-eval';
import { pvpScore, runsFor } from './pvp-optimizer';
import type { FighterModel } from './pvp-opponent';

export interface DeepContext {
  goal: DeepGoal;
  /** the save the builds are laid on (its inventory holds every piece a build may name) */
  state: SaveState;
  sector: SectorInfo;
  cats: EnemyCategory[];
  regenTable?: number[];
  weakBothPct?: number;
  potions: Consumable[];
  /** psWeight per perk id, for PWR */
  perkWeights?: Record<number, number>;
  /** progress: where a lap starts and with how much HP (null: full) */
  startIndex?: number;
  startHp?: number | null;
  pvpPool?: FighterModel[];
  bossPool?: FighterModel[];
  /** the Arena instead of the sector, and the potion doses that go down at its start */
  arena?: ArenaSettings;
  potionDoses?: number;
}

const EMPTY: DeepEval = { value: 0, margin: 0, clear: 0, depth: 0, lapSeconds: null, potionEnd: null };

export function deepEvaluate(ctx: DeepContext, builds: DeepBuild[], laps: number, seed: number, schedule: DeepSchedule | null): DeepEval[] {
  const byUid = new Map(ctx.state.inventory.map((i) => [i.uid, i]));
  const mods = ctx.potions.length ? mergeMods(ctx.potions.map((c) => c.mods)) : null;
  const xpMult = 1 + (mods?.xpBonusPct ?? 0);
  const doses = ctx.potions.map((c) => c.durationSec).filter((d) => d > 0);
  const dose = doses.length ? Math.min(...doses) : 0;
  return builds.map((b): DeepEval => {
    const state: SaveState = {
      ...ctx.state,
      allocatedHp: b.alloc.hp,
      allocatedAtk: b.alloc.atk,
      allocatedDef: b.alloc.def,
      allocatedCrit: b.alloc.crit,
      allocatedParry: b.alloc.parry,
      equippedUids: b.uids,
      equippedPerkIds: b.perks,
    };
    const items = b.uids.flatMap((uid) => {
      const it = byUid.get(uid);
      return it ? [it] : [];
    });
    const perkWeight = b.perks.reduce((a, id) => a + (ctx.perkWeights?.[id] ?? 0), 0);
    const plan = planProfile(state, items, b.perks, { perkWeight, weakBothPct: ctx.weakBothPct });
    const base = plan.profile;
    const potted = mods ? withConsumables(base, mods) : base;
    if (ctx.arena && ctx.goal === 'progress') {
      const seconds = mods && dose > 0 ? dose * Math.max(1, ctx.potionDoses ?? 1) : 0;
      const r = simulateArena(seconds ? base : potted, ctx.arena.world, ctx.arena.start, { runs: laps, hours: ctx.arena.hours, seed, ...(seconds ? { potion: { profile: potted, seconds } } : {}) });
      // scored in kills: 10 a wave
      return { ...EMPTY, value: r.record, depth: r.best * 10 };
    }
    if (ctx.arena && (ctx.goal === 'damage' || ctx.goal === 'survival')) {
      const wave = Math.max(1, ctx.arena.start.wave);
      const avg = arenaAverages(arenaOdds(potted, arenaRoster(ctx.arena.world, wave), wave, Math.max(2, Math.ceil(laps / 2)), seed));
      return { ...EMPTY, value: ctx.goal === 'damage' ? avg.damagePerRound : avg.hpPerFight };
    }
    switch (ctx.goal) {
      case 'progress': {
        const timed = mods && schedule && dose > 0 ? { profile: potted, fromIndex: schedule.fromIndex, seconds: schedule.doses * dose } : null;
        const lapProfile = timed ? base : potted;
        const startHp = ctx.startHp === null || ctx.startHp === undefined ? undefined : Math.min(potted.maxHp, ctx.startHp);
        const r = simulateSector(lapProfile, ctx.sector, ctx.cats, { runs: laps, seed, regenTable: ctx.regenTable, startIndex: ctx.startIndex, startHp, ...(timed ? { potion: timed } : {}) });
        return { ...EMPTY, value: r.clearProb, clear: r.clearProb, depth: r.survival.reduce((a, v) => a + v, 0), lapSeconds: r.clearSeconds, potionEnd: r.potionEnd };
      }
      case 'farm': {
        const r = simulateFarm(potted, ctx.sector, ctx.cats, { attempts: laps, seed, regenTable: ctx.regenTable, playerLevel: ctx.state.level });
        return { ...EMPTY, value: r.xpPerHour * xpMult, clear: r.clearProb, depth: r.depth };
      }
      case 'damage':
      case 'survival': {
        const avg = sectorFights(potted, ctx.sector, ctx.cats, { fights: Math.max(2, Math.ceil(laps / 2)), seed, regenTable: ctx.regenTable });
        return { ...EMPTY, value: ctx.goal === 'damage' ? avg.damagePerRound : avg.hpPerFight };
      }
      case 'pvp':
      case 'boss': {
        const pool = (ctx.goal === 'pvp' ? ctx.pvpPool : ctx.bossPool) ?? [];
        if (!pool.length) return EMPTY;
        const s = pvpScore(base, b.perks, pool, runsFor(pool, Math.max(2, Math.ceil(laps / 2))), seed);
        return { ...EMPTY, value: s.win, margin: s.margin };
      }
      default:
        return { ...EMPTY, value: plan.build.power };
    }
  });
}
