/**
 * Ranking gear by what it actually does in the sector you are in, instead of by PWR.
 *
 * PWR (`GetPowerScore`) is the game's shop-window number: a fixed 0.8·HP + 9·ATK + 6·DEF + 6·CRIT +
 * 8·PARRY. It knows nothing about who you are fighting, so it misses the two things that move the
 * needle most — the element matchup against this sector's enemies, and the procs on the item. A
 * Holy weapon with less PWR can out-damage a Frost one by 24 % against enemies weak to Holy.
 *
 * So every candidate is turned into a real PlayerProfile and measured against the sector's weighted
 * enemy mix, the same mix the simulator rolls from.
 */
import type { SaveItem, SaveState } from './contracts';
import {
  COMBAT,
  buildProfile,
  elementMultiplier,
  belowHpAggregate,
  expectFight,
  lowHpProfile,
  normCdf,
  normPdf,
  lowHpRegen,
  rosterAt,
  type RosterEntry,
  shareUnder,
  xpMultiplier,
  type EnemyCategory,
  type FightExpectation,
  type PerkMods,
  type PlayerProfile,
  type SectorEnemy,
  type SectorInfo,
} from './combat';
import { estimateBuild, equippedItems, isShield, type Stats } from './game-math';
import { mergeProcs } from './item-effects';
import { mergePerkCombat, mergePerkProcs, mergePerkStats } from './perk-mods';
import { SEARCH_RUNS, pvpWinRate, runsFor } from './pvp-optimizer';
import type { FighterModel } from './pvp-opponent';

export interface MixEntry {
  enemy: SectorEnemy;
  /** share of the fights in one lap through the sector */
  weight: number;
}

/** Every enemy of the sector with how often it shows up in a full lap. */
export function sectorMix(sector: SectorInfo, cats: EnemyCategory[]): MixEntry[] {
  const mix = new Map<SectorEnemy, number>();
  for (let i = 0; i < sector.totalEnemies; i++) {
    for (const r of rosterAt(sector, cats, i)) mix.set(r.variant, (mix.get(r.variant) ?? 0) + r.prob);
  }
  const total = [...mix.values()].reduce((a, b) => a + b, 0) || 1;
  return [...mix.entries()].map(([enemy, n]) => ({ enemy, weight: n / total }));
}

export interface SectorValue {
  /** damage we land per round, averaged over the sector's enemies */
  damagePerRound: number;
  /** damage we take per round, same average */
  takenPerRound: number;
  /** HP left after an average fight, end-of-fight regen included */
  hpPerFight: number;
  /** seconds an average fight takes */
  secondsPerFight: number;
  /** XP per hour at that pace */
  xpPerHour: number;
  /** average damage multiplier our weapons get from this sector's weaknesses and resistances */
  elementMult: number;
  /** one attempt through the sector: how deep it gets and what it banks */
  run: SectorRun;
}

/** What a build is worth against one sector, all of it weighted by how often each enemy appears. */
export function sectorValue(p: PlayerProfile, sector: SectorInfo, cats: EnemyCategory[], mix = sectorMix(sector, cats), regenTable?: number[], playerLevel?: number): SectorValue {
  let damage = 0;
  let taken = 0;
  let hp = 0;
  let seconds = 0;
  let xp = 0;
  let element = 0;
  // the run fights the same enemies: work each one out once
  const known = new Map<SectorEnemy, FightExpectation>();
  for (const { enemy, weight } of mix) {
    const ex = expectFight(p, enemy, sector.id, regenTable);
    known.set(enemy, ex);
    damage += weight * (ex.playerHit * ex.playerLandRate + ex.dotPerRound);
    taken += weight * ex.damageTakenPerRound;
    hp += weight * ex.hpDelta;
    seconds += weight * ex.seconds;
    xp += weight * enemy.xpBase * (playerLevel === undefined ? 1 : xpMultiplier(playerLevel, enemy.level, sector.id));
    element += weight * elementMultiplier(p.weaponElements, enemy, p.weakBothPct, p.ignoreResist);
  }
  return {
    damagePerRound: damage,
    takenPerRound: taken,
    hpPerFight: hp,
    secondsPerFight: seconds,
    xpPerHour: seconds > 0 ? (xp / seconds) * 3600 : 0,
    elementMult: element,
    run: sectorRun(p, sector, cats, regenTable, playerLevel, known),
  };
}

export type GearMetric = 'farm' | 'progress' | 'pvp' | 'boss' | 'damage' | 'survival' | 'power';

export interface GearPick {
  item: SaveItem;
  slot: string;
  replaces: SaveItem | null;
  /** the build with this item in that slot */
  stats: Stats;
  power: number;
  powerDelta: number;
  value: SectorValue;
  /** change against the current gear, as a fraction */
  damageDelta: number;
  takenDelta: number;
  hpPerFightDelta: number;
  /** XP per hour of the real farm loop, relative to now */
  farmDelta: number;
  /** enemies deeper into the sector than the current build reaches */
  depthDelta: number;
  /** mean win chance against what is being ranked (the arena, or the boss), and its change */
  pvpWin: number;
  pvpDelta: number;
  /** what the ranking sorts on */
  score: number;
}

export interface SlotPicks {
  slot: string;
  current: SaveItem | null;
  currentValue: SectorValue;
  options: GearPick[];
}

export interface GearContext {
  sector: SectorInfo;
  cats: EnemyCategory[];
  /** the perk loadout to plan with; defaults to what is equipped */
  perkIds?: number[];
  /** sum of PerkData.psWeight for those perks, for the PWR number */
  perkWeight?: number;
  weakBothPct?: number;
  regenTable?: number[];
  metric?: GearMetric;
  /** the arena population to score against; only the 'pvp' metric uses it */
  pvpPool?: FighterModel[];
  /** the PvP boss to beat (pvp-boss.ts); only the 'boss' metric uses it */
  bossPool?: FighterModel[];
  /** the game's perk combat texts (live tap); the worker installs them before evaluating */
  perkTexts?: Record<number, string>;
  /**
   * Our level, so XP is paid at what the enemy is actually worth to us. Leave it out and the model
   * assumes no over-level penalty, which only holds while the sector is still near our level.
   */
  playerLevel?: number;
}

/**
 * A full build, items and perks together. The perk numbers come from our own table (perk-mods.ts)
 * rather than the live reading, because the live one only ever describes the equipped loadout — and
 * using one source for both sides keeps "atual vs planejada" an apples-to-apples comparison.
 */
export function planProfile(state: SaveState, items: SaveItem[], perkIds: number[], ctx: Pick<GearContext, 'perkWeight' | 'weakBothPct'>) {
  const stats = mergePerkStats(perkIds);
  const build = estimateBuild(state, items, { mods: stats, weight: ctx.perkWeight ?? 0 });
  const profile = buildProfile(build.stats, items, mergePerkCombat(perkIds), ctx.weakBothPct ?? COMBAT.WEAK_BOTH_PCT);
  return { build, profile: { ...profile, procs: mergeProcs(profile.procs, mergePerkProcs(perkIds)) } };
}

const ITEM_SLOT_NAMES = ['Testa', 'Corpo', 'Cintura', 'Arma', 'Anello', 'Trinket'];

function scoreOf(metric: GearMetric, pick: Omit<GearPick, 'score'>): number {
  switch (metric) {
    case 'farm':
      return pick.farmDelta;
    case 'progress':
      return pick.depthDelta;
    case 'pvp':
    case 'boss':
      return pick.pvpDelta;
    case 'damage':
      return pick.damageDelta;
    case 'survival':
      return pick.hpPerFightDelta;
    default:
      return pick.powerDelta;
  }
}

/**
 * Every unequipped item that fits each slot, measured against the sector. The current gear is the
 * baseline, so the deltas read as "what changes if I put this on".
 */
export function rankGear(state: SaveState, ctx: GearContext): SlotPicks[] {
  const metric = ctx.metric ?? 'farm';
  const mix = sectorMix(ctx.sector, ctx.cats);
  const equipped = equippedItems(state);
  const current = equipped.flatMap((e) => (e.item ? [e.item] : []));
  const perkIds = (ctx.perkIds ?? state.equippedPerkIds ?? []).filter((id) => id > 0);
  const basePlan = planProfile(state, current, perkIds, ctx);
  const base = basePlan.build;
  const baseValue = sectorValue(basePlan.profile, ctx.sector, ctx.cats, mix, ctx.regenTable, ctx.playerLevel ?? state.level);
  // The arena is simulated fight by fight, far dearer than the PvE estimate, so it only runs when
  // it is what is being ranked.
  const pool = metric === 'pvp' ? (ctx.pvpPool ?? []) : metric === 'boss' ? (ctx.bossPool ?? []) : [];
  const runs = runsFor(pool, SEARCH_RUNS);
  const basePvp = pool.length ? pvpWinRate(basePlan.profile, perkIds, pool, runs) : 0;
  const equippedUids = new Set(state.equippedUids);
  const rel = (now: number, before: number) => (Math.abs(before) > 1e-9 ? (now - before) / Math.abs(before) : now > 0 ? 1 : 0);

  return equipped.map((slotEntry, idx) => {
    const options: GearPick[] = [];
    // an identical copy is the same pick; the copy of what the slot already holds is no pick at all
    const templates = new Set<number>(slotEntry.item ? [slotEntry.item.templateId] : []);
    for (const item of [...state.inventory].sort((a, b) => a.uid - b.uid)) {
      if (equippedUids.has(item.uid)) continue;
      if (templates.has(item.templateId)) continue;
      templates.add(item.templateId);
      if (!slotEntry.slot.startsWith(ITEM_SLOT_NAMES[item.slot] ?? '')) continue;
      if (isShield(item) && slotEntry.slot !== 'Arma 2') continue; // shields only in Arma 2
      const items = equipped.flatMap((x, j) => (j === idx ? [item] : x.item ? [x.item] : []));
      const plan = planProfile(state, items, perkIds, ctx);
      const build = plan.build;
      const value = sectorValue(plan.profile, ctx.sector, ctx.cats, mix, ctx.regenTable, ctx.playerLevel ?? state.level);
      const pvpWin = pool.length ? pvpWinRate(plan.profile, perkIds, pool, runs) : 0;
      const pick = {
        item,
        slot: slotEntry.slot,
        replaces: slotEntry.item,
        stats: build.stats,
        power: build.power,
        powerDelta: build.power - base.power,
        value,
        damageDelta: rel(value.damagePerRound, baseValue.damagePerRound),
        takenDelta: rel(value.takenPerRound, baseValue.takenPerRound),
        hpPerFightDelta: value.hpPerFight - baseValue.hpPerFight,
        farmDelta: rel(value.run.xpPerHour, baseValue.run.xpPerHour),
        depthDelta: value.run.depth - baseValue.run.depth,
        pvpWin,
        pvpDelta: pvpWin - basePvp,
      };
      options.push({ ...pick, score: scoreOf(metric, pick) });
    }
    options.sort((a, b) => b.score - a.score);
    return { slot: slotEntry.slot, current: slotEntry.item, currentValue: baseValue, options };
  });
}

export interface SectorRun {
  /** how far into the sector one attempt gets before dying; `totalEnemies` when it survives a lap */
  depth: number;
  /** true when the whole lap is expected to survive */
  clears: boolean;
  /** XP the attempt banks before dying */
  xpPerAttempt: number;
  secondsPerAttempt: number;
  /** the rate of the real loop: fight until death, restart at enemy 0, repeat */
  xpPerHour: number;
  /** HP left at the deepest point reached */
  lowestHp: number;
  /** the chance to get through the whole sector in one attempt */
  clearProb: number;
}

/**
 * Walks one attempt through the sector, enemy by enemy, carrying HP from fight to fight the way the
 * game does. Dying resets progress, so the farm rate is what you bank *before* dying — a build that
 * dies at enemy 6 only ever farms the six weakest enemies, no matter how fast it kills them.
 *
 * This uses expected values, so it is a ranking proxy, not a forecast: the Monte Carlo in the
 * simulator is what accounts for the runs that end early to bad luck.
 */
export function sectorRun(
  p: PlayerProfile,
  sector: SectorInfo,
  cats: EnemyCategory[],
  regenTable?: number[],
  playerLevel?: number,
  /** fights already worked out for this profile (sectorValue passes its own) */
  known?: Map<SectorEnemy, FightExpectation>,
): SectorRun {
  // Each fight is won with a probability, from the HP we start it with and the mean and spread of
  // what it costs. The run carries the HP of the attempts still standing as a distribution (bins,
  // each with its own mean), so a lucky and an unlucky attempt are not averaged into one that is
  // neither: XP and time are weighted by the chance to be there, and `depth` is the expected number
  // of fights won.
  const cache = known ?? new Map<SectorEnemy, FightExpectation>();
  // "Below X% HP: +DEF / +ATK / absorb…" is on only once the run has worn us down, and the clauses
  // add up (GetBelowHpAggregate): under the k-th line from the top, the first k clauses hold. The
  // fight is blended across those bands by the share of it spent in each.
  const clauses = p.procs.belowHp
    .filter((b) => b.atkPct || b.atkFlat || b.defPct || b.allStats || b.lifestealPct || b.regenPerAttack || b.absorbPct || b.immuneCrit)
    .sort((a, b) => b.pct - a.pct);
  // band k: the first k+1 clauses summed, the way the game sums them
  const bands: PlayerProfile[] = clauses.map((_, k) => lowHpProfile(p, belowHpAggregate(clauses.slice(0, k + 1), 0, 1)!));
  const bandCache = bands.map(() => new Map<SectorEnemy, ReturnType<typeof expectFight>>());
  const BINS = RUN_BINS;
  const binOf = (h: number) => Math.max(0, Math.min(BINS - 1, Math.floor((h / p.maxHp) * BINS)));
  let mass = new Float64Array(BINS);
  let hpSum = new Float64Array(BINS);
  mass[BINS - 1] = 1;
  hpSum[BINS - 1] = p.maxHp;
  let xp = 0;
  let seconds = 0;
  let depth = 0;
  let lowest = p.maxHp;
  let alive = 1;
  for (let i = 0; i < sector.totalEnemies && alive > 1e-4; i++) {
    const nextMass = new Float64Array(BINS);
    const nextSum = new Float64Array(BINS);
    const roster = runRoster(sector, cats, i);
    for (let b = 0; b < BINS; b++) {
      const m = mass[b]!;
      if (m < 1e-6 * alive) continue;
      const hp = hpSum[b]! / m;
      for (const r of roster) {
        let ex = cache.get(r.variant);
        if (!ex) cache.set(r.variant, (ex = expectFight(p, r.variant, sector.id, regenTable)));
        // a "below X% HP" regen only pays once the run has worn us down, so it depends on where we are
        const loss = Math.max(0, ex.regen - ex.hpDelta);
        const low = lowHpRegen(p, hp, loss, ex.rounds * 2 * COMBAT.TURN_SECONDS);
        let fightDelta = ex.hpDelta;
        let fightSecs = ex.seconds;
        if (bands.length) {
          // share of the fight under each line, top line first; the band between two lines runs on
          // the clauses above the lower one
          let above = 1;
          fightDelta = 0;
          fightSecs = 0;
          let prev = ex;
          for (let k = 0; k <= bands.length; k++) {
            const under = k < bands.length ? shareUnder(hp, loss, clauses[k]!.pct * p.maxHp) : 0;
            const w = Math.max(0, above - under);
            fightDelta += w * prev.hpDelta;
            fightSecs += w * prev.seconds;
            above = under;
            if (k < bands.length) {
              let exK = bandCache[k]!.get(r.variant);
              if (!exK) bandCache[k]!.set(r.variant, (exK = expectFight(bands[k]!, r.variant, sector.id, regenTable)));
              prev = exK;
            }
          }
        }
        // the fight's cost (the end-of-fight regen only lands on a win) and the chance it stays under our HP
        const mu = ex.regen - (fightDelta + low);
        const sd = Math.max(1, ex.lossSd);
        const z = (hp - mu) / sd;
        const pw = normCdf(z);
        const w = m * r.prob;
        // a lost fight ends when our HP runs out, partway through
        seconds += w * (pw * fightSecs + (1 - pw) * fightSecs * Math.min(1, hp / Math.max(1, mu)));
        if (pw < 1e-9) continue;
        xp += w * pw * r.variant.xpBase * (playerLevel === undefined ? 1 : xpMultiplier(playerLevel, r.variant.level, sector.id));
        // a fight all but certain to be won only moves the HP; a risky one splits the winners at
        // three quantiles of what they paid (the cost below our HP), which is where spread matters
        if (pw > 0.999) {
          const after = Math.max(1, Math.min(p.maxHp, hp - (mu - (sd * normPdf(z)) / pw) + ex.regen));
          const k = binOf(after);
          nextMass[k]! += w * pw;
          nextSum[k]! += w * pw * after;
          continue;
        }
        for (const q of RUN_QUANTILES) {
          const cost = mu + sd * normInv(Math.max(1e-12, q * pw));
          const after = Math.max(1, Math.min(p.maxHp, hp - cost + ex.regen));
          const k = binOf(after);
          nextMass[k]! += (w * pw) / RUN_QUANTILES.length;
          nextSum[k]! += ((w * pw) / RUN_QUANTILES.length) * after;
        }
      }
    }
    mass = nextMass;
    hpSum = nextSum;
    alive = mass.reduce((a, v) => a + v, 0);
    depth += alive;
    if (alive > 1e-9) lowest = Math.min(lowest, hpSum.reduce((a, v) => a + v, 0) / alive);
  }
  const clearProb = alive;
  return { depth, clears: clearProb >= 0.5, clearProb, xpPerAttempt: xp, secondsPerAttempt: seconds, xpPerHour: seconds > 0 ? (xp / seconds) * 3600 : 0, lowestHp: clearProb >= 0.5 ? lowest : 0 };
}

/**
 * The roster of one index for the run: the category curve has long tails, and entries under 0.1%
 * cost as much to work out as the ones that matter. Kept per sector (the roster never changes).
 */
const rosterCache = new WeakMap<EnemyCategory[], Map<string, RosterEntry[]>>();
function runRoster(sector: SectorInfo, cats: EnemyCategory[], index: number): RosterEntry[] {
  let bySector = rosterCache.get(cats);
  if (!bySector) rosterCache.set(cats, (bySector = new Map()));
  const key = `${sector.id}|${index}`;
  let hit = bySector.get(key);
  if (!hit) {
    const all = rosterAt(sector, cats, index);
    const kept = all.filter((r) => r.prob >= 1e-3);
    const total = kept.reduce((a, r) => a + r.prob, 0) || 1;
    hit = kept.map((r) => ({ ...r, prob: r.prob / total }));
    bySector.set(key, hit);
  }
  return hit;
}

/** How finely the run keeps the HP of the attempts still standing, and where it samples each fight's cost. */
const RUN_BINS = 12;
const RUN_QUANTILES = [1 / 6, 1 / 2, 5 / 6];

/** The standard normal's quantile (Acklam's rational approximation, relative error < 1.2e-9). */
export function normInv(pr: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (pr <= 0) return -Infinity;
  if (pr >= 1) return Infinity;
  if (pr < lo) {
    const q = Math.sqrt(-2 * Math.log(pr));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (pr > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - pr));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = pr - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
