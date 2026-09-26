/**
 * Turning a replay into two fighters the duel simulator can replay.
 *
 * Gear is exact: item stats and effects are fixed per template and the replay names every piece.
 * What the replay does not say is where each side put its stat points and which perks it ran. So:
 *
 * - Stats. With the live tap on, the arena hands us the opponent's own numbers
 *   (PlayerSnapshot / EnemyState, perks included) and we use them as they are. Otherwise they are
 *   measured from the fight — but only from plain hits. The raw averages are contaminated by the very
 *   mechanics the simulator adds back: bajanggg critted on 81% of his hits because every parry armed
 *   a guaranteed crit, and every swing after the 60th is inflated by sudden death. Measured naively,
 *   those would be counted twice. So ATK and DEF come from pre-sudden-death, non-crit, un-armed hits,
 *   crit from hits that were not armed by a parry, and parry from the rate our attacks were parried
 *   with our own parry-ignore divided back out. Small samples are pulled towards what the gear alone
 *   suggests.
 * - Perks. Known exactly when scouted live; otherwise inferred from signatures in the log that
 *   nothing else produces: Thorns sends back half of every landed hit, Crimson Vow heals exactly 3
 *   on each landed hit, Last Breath leaves exactly a quarter of max HP after a lethal blow.
 */
import type { CatalogItem, PvpFighter, PvpScouted, PvpTurn, SaveItem } from './contracts';
import { COMBAT, buildProfile, type ElementName, type PerkMods } from './combat';
import { PER_POINT, type Stats } from './game-math';
import { mergeProcs, parseProcs } from './item-effects';
import { mergePerkCombat, mergePerkProcs } from './perk-mods';
import { fighterBuild, fighterItems } from './pvp-analysis';
import { PVP, forPvp, type PvpProfile } from './duel';

const THORNS = 19;
const CRIMSON_VOW = 12;
const LAST_BREATH = 29;
const DYING_FURY = 11;
const ARMOR_PIERCER = 31;
const MIRROR_ECHO = 26;

/**
 * Armor Piercer from how often the other side's parry held. `otherParry` is the parry stat of the
 * fighter being pierced; the perk scales it by 0.65. Called only for the opponent, with our exact
 * parry: over the 828 swings of today's build we parried 38.2% against a 43.0% stat.
 */
export function inferPiercing(log: PvpTurn[], side: Side, otherParry: number): { pierce: boolean; seen: number; n: number } {
  const mine = side === 'you';
  const swings = log.filter((t) => t.playerAttacking === mine);
  const stopped = swings.filter((t) => t.parried).length;
  const n = swings.length;
  const seen = n ? stopped / n : 0;
  const full = Math.min(COMBAT.PARRY_CAP, otherParry) / 100;
  const pierced = full * 0.65;
  // closer to the pierced rate than to the full one, on a sample big enough to mean it
  const pierce = n >= 12 && Math.abs(seen - pierced) < Math.abs(seen - full) && seen < full - 1.5 * Math.sqrt((full * (1 - full)) / n);
  return { pierce, seen, n };
}

export type Side = 'you' | 'them';

/** Walks the log once, remembering each swing's attacker state. */
interface Swing {
  t: PvpTurn;
  index: number;
  /** the attacker's n-th attack */
  k: number;
  /** attacker's HP before this swing */
  hpBefore: number;
  /** the attacker's previous swing target parried us just before, arming this one */
  armedByParry: boolean;
  /** how many of the attacker's hits had landed before this one */
  landedBefore: number;
}

function swingsOf(log: PvpTurn[], side: Side, maxHp: number): Swing[] {
  const mine = side === 'you';
  const out: Swing[] = [];
  let k = 0;
  let hp = maxHp;
  let armed = false;
  let landed = 0;
  for (let i = 0; i < log.length; i++) {
    const t = log[i]!;
    if (t.playerAttacking === mine) {
      k++;
      out.push({ t, index: i, k, hpBefore: hp, armedByParry: armed, landedBefore: landed });
      armed = false;
      if (!t.parried) landed++;
    } else if (t.parried) {
      armed = true; // we just parried: our next swing is the one a Dawnguard Pendant arms
    }
    hp = mine ? t.hpPlayer : t.hpEnemy;
  }
  return out;
}

export interface InferredPerks {
  ids: number[];
  /** why each one was inferred, in words */
  why: string[];
}

/** Perks with a signature in the log that no item can produce. */
export function inferPerks(log: PvpTurn[], side: Side, maxHp: number): InferredPerks {
  const mine = side === 'you';
  const ids: number[] = [];
  const why: string[] = [];

  // Thorns: when the other side lands a hit, this side sends ~half of it back
  let reflected = 0;
  let taken = 0;
  let hits = 0;
  for (const t of log) {
    if (t.playerAttacking === mine || t.parried || t.damage <= 0) continue;
    const back = mine ? t.counterPlayer : t.counterEnemy;
    if (back > 0) {
      reflected += back;
      taken += t.damage;
      hits++;
    }
  }
  const ratio = taken > 0 ? reflected / taken : 0;
  if (hits >= 3 && Math.abs(ratio - 1) < 0.08) {
    // twice Thorns: Mirror Echo right behind it
    ids.push(THORNS, MIRROR_ECHO);
    why.push(`Thorns + Mirror Echo: devolveu ${Math.round(100 * ratio)}% de ${hits} golpes recebidos`);
  } else if (hits >= 3 && Math.abs(ratio - 0.5) < 0.08) {
    ids.push(THORNS);
    why.push(`Thorns: devolveu ${Math.round(100 * ratio)}% de ${hits} golpes recebidos`);
  }

  // Crimson Vow: heals exactly 3 on its own landed hits, even when nothing else heals
  const landed = swingsOf(log, side, maxHp).filter((s) => !s.t.parried && s.hpBefore < maxHp);
  const threes = landed.filter((s) => (mine ? s.t.healPlayer : s.t.healEnemy) % 3 === 0 && (mine ? s.t.healPlayer : s.t.healEnemy) >= 3).length;
  if (landed.length >= 5 && threes / landed.length >= 0.8) {
    ids.push(CRIMSON_VOW);
    why.push(`Crimson Vow: curou múltiplos de 3 em ${threes} de ${landed.length} acertos`);
  }

  // Dying Fury: plain hits under 40% HP land ~1.8× harder than the same fighter's hits above it
  const own = swingsOf(log, side, maxHp).filter((s) => !s.t.parried && !s.t.crit && !s.t.suddenDeath && s.landedBefore > 0);
  const high = own.filter((s) => s.hpBefore >= 0.5 * maxHp);
  const low = own.filter((s) => s.hpBefore < 0.4 * maxHp);
  if (high.length >= 3 && low.length >= 2) {
    const mean = (xs: Swing[]) => xs.reduce((a, s) => a + s.t.damage, 0) / xs.length;
    const ratio = mean(low) / mean(high);
    if (ratio >= 1.5) {
      ids.push(DYING_FURY);
      why.push(`Dying Fury: golpes normais ${ratio.toFixed(1)}× mais fortes abaixo de 40% da vida`);
    }
  }

  // Last Breath: a lethal blow that leaves exactly a quarter
  const floor = Math.round(maxHp * PVP.LAST_BREATH_FLOOR);
  let hpPrev = maxHp;
  for (const t of log) {
    const hp = mine ? t.hpPlayer : t.hpEnemy;
    const hitMe = t.playerAttacking !== mine && !t.parried;
    if (hitMe && t.damage >= hpPrev && Math.abs(hp - floor) <= 2) {
      ids.push(LAST_BREATH);
      why.push(`Last Breath: um golpe letal o deixou com ${hp} de vida (25%)`);
      break;
    }
    hpPrev = hp;
  }
  return { ids, why };
}

export interface SideStats extends Stats {
  /** how many plain hits each measurement rests on */
  samples: { atk: number; def: number; crit: number; parry: number };
}

/** A pseudo-count pull towards a prior, so three lucky hits cannot set a stat. */
const shrink = (hits: number, n: number, prior: number, k: number) => (hits + prior * k) / (n + k);

export interface MeasureContext {
  /** the other side's stats (hp = its max HP) and what it ignores of our parry */
  other: Stats;
  otherIgnoreParryPct: number;
  otherDamageMult: number;
  /** this side's gear, to skip swings its "every N attacks" procs armed */
  items: SaveItem[];
  /** what the gear alone suggests, used where the sample is thin */
  prior: Stats;
}

/**
 * Base stats from a fight's log, with the mechanics the simulator replays taken back out.
 * `side` is the fighter being measured; `other` is the one it fought.
 */
export function measureSide(log: PvpTurn[], side: Side, maxHp: number, ctx: MeasureContext): SideStats {
  const procs = parseProcs(ctx.items.flatMap((i) => i.effects));
  const every = procs.everyNAttacks.map((e) => e.n);
  const mine = side === 'you';
  const sw = swingsOf(log, side, maxHp);
  const plain = (s: Swing) =>
    !s.t.parried &&
    !s.t.crit &&
    !s.t.suddenDeath &&
    s.index + 1 < PVP.SD_THRESHOLD &&
    !every.some((n) => s.k > 1 && (s.k - 1) % n === 0) &&
    s.landedBefore > 0 &&
    s.hpBefore >= 0.5 * maxHp;

  // ATK: what our DEF let through, turned back into their ATK
  const atkHits = sw.filter(plain);
  const meanOut = atkHits.length ? atkHits.reduce((a, s) => a + s.t.damage, 0) / atkHits.length : 0;
  const atk = atkHits.length >= 3 ? (meanOut * (COMBAT.DEF_K + ctx.other.def)) / COMBAT.DEF_K : ctx.prior.atk;

  // DEF: what the other side's plain hits did to this one. Its low-HP swings are left out too:
  // Dying Fury alone adds 80% ATK under 40% HP and would make this DEF look like nothing.
  const otherSide: Side = mine ? 'them' : 'you';
  const otherMax = Math.max(1, ctx.other.hp);
  const inHits = swingsOf(log, otherSide, otherMax).filter(
    (s) => !s.t.parried && !s.t.crit && !s.t.suddenDeath && s.index + 1 < PVP.SD_THRESHOLD && s.landedBefore > 0 && s.hpBefore >= 0.5 * otherMax,
  );
  const meanIn = inHits.length ? inHits.reduce((a, s) => a + s.t.damage, 0) / inHits.length : 0;
  const otherAtk = ctx.other.atk * ctx.otherDamageMult;
  const def = inHits.length >= 3 && meanIn > 0 ? Math.max(0, (COMBAT.DEF_K * otherAtk) / meanIn - COMBAT.DEF_K) : ctx.prior.def;

  // CRIT: only the hits no parry armed
  const critPool = sw.filter((s) => !s.t.parried && !s.armedByParry);
  const crits = critPool.filter((s) => s.t.crit).length;
  const crit = 100 * shrink(crits, critPool.length, ctx.prior.crit / 100, 6);

  // PARRY: how often the other side's attacks were stopped, our Armor Piercer divided back out
  const theirSwings = log.filter((t) => t.playerAttacking !== mine);
  const stopped = theirSwings.filter((t) => t.parried).length;
  const seen = stopped / Math.max(1, theirSwings.length);
  const base = ctx.otherIgnoreParryPct < 1 ? seen / (1 - ctx.otherIgnoreParryPct) : seen;
  const parry = Math.min(COMBAT.PARRY_CAP, 100 * shrink(base * theirSwings.length, theirSwings.length, ctx.prior.parry / 100, 8));

  return {
    hp: maxHp,
    atk,
    def,
    crit,
    parry,
    samples: { atk: atkHits.length, def: inHits.length, crit: critPool.length, parry: theirSwings.length },
  };
}

/** Gear plus the level's points spread like `split`: the fallback where the log says little. */
export function priorStats(fighter: PvpFighter, byName: Map<string, CatalogItem>, split: Partial<Stats>): Stats {
  const b = fighterBuild(fighter, byName);
  const rest = Math.max(0, b.points - b.hpPoints);
  const w = { atk: split.atk ?? 1, def: split.def ?? 1, crit: split.crit ?? 1, parry: split.parry ?? 1 };
  const sum = w.atk + w.def + w.crit + w.parry || 4;
  return {
    hp: fighter.maxHp,
    atk: b.gear.atk + ((rest * w.atk) / sum) * PER_POINT.atk,
    def: b.gear.def + ((rest * w.def) / sum) * PER_POINT.def,
    crit: b.gear.crit + ((rest * w.crit) / sum) * PER_POINT.crit,
    parry: b.gear.parry + ((rest * w.parry) / sum) * PER_POINT.parry,
  };
}

export interface FighterModel {
  name: string;
  level: number;
  profile: PvpProfile;
  stats: Stats;
  statsSource: 'jogo' | 'medido';
  perkIds: number[];
  perkSource: 'jogo' | 'inferido';
  notes: string[];
  /** resist / weakness to the attacker's weapons: only the PvP bosses have them */
  elements?: { resist?: ElementName; resist2?: ElementName; weak?: ElementName };
}

/**
 * A fighter ready for the simulator. With `exact` stats (scouted live), the perks' combat modifiers
 * apply on top as the game applies them. With measured stats, the damage multipliers are already
 * baked into what we measured, so only the procs and heals are added.
 */
export function fighterModel(
  fighter: PvpFighter,
  items: SaveItem[],
  stats: Stats,
  perkIds: number[],
  source: FighterModel['statsSource'],
  perkSource: FighterModel['perkSource'],
  notes: string[] = [],
): FighterModel {
  const combat: PerkMods = mergePerkCombat(perkIds);
  const mods: PerkMods =
    source === 'jogo'
      ? combat
      : { ...combat, damageDealtMult: 1, damageTakenMult: 1, bonusDamageFlatPerHit: 0 };
  const base = buildProfile(stats, items, mods);
  const profile = forPvp({ ...base, procs: mergeProcs(base.procs, mergePerkProcs(perkIds)) }, perkIds);
  return { name: fighter.name, level: fighter.level, profile, stats, statsSource: source, perkIds, perkSource, notes };
}

export interface OpponentInput {
  opponent: PvpFighter;
  log: PvpTurn[];
  byName: Map<string, CatalogItem>;
  /** our side in that fight, as the simulator sees it */
  us: { stats: Stats; ignoreParryPct: number; damageMult: number };
  scout?: PvpScouted;
  /** how points are usually spread, for the prior */
  split: Partial<Stats>;
}

/** The opponent of one archived fight. */
export function opponentModel(input: OpponentInput): FighterModel {
  const { opponent, log, byName } = input;
  const items = fighterItems(opponent, byName);
  const scout = input.scout;
  const inferred = inferPerks(log, 'them', opponent.maxHp);
  const pierce = inferPiercing(log, 'them', input.us.stats.parry);
  if (pierce.pierce) {
    inferred.ids.push(ARMOR_PIERCER);
    inferred.why.push(`Armor Piercer: você aparou ${Math.round(100 * pierce.seen)}% de ${pierce.n} ataques, contra ${Math.round(Math.min(COMBAT.PARRY_CAP, input.us.stats.parry))}% do seu stat`);
  }

  if (scout && scout.atk > 0) {
    const stats: Stats = { hp: scout.maxHp, atk: scout.atk, def: scout.def, crit: scout.crit, parry: scout.parry };
    const known = Boolean(scout.perkIds?.length);
    return fighterModel(opponent, items, stats, known ? scout.perkIds! : inferred.ids, 'jogo', known ? 'jogo' : 'inferido', known ? [] : inferred.why);
  }

  const prior = priorStats(opponent, byName, input.split);
  const stats = measureSide(log, 'them', opponent.maxHp, {
    other: input.us.stats,
    otherIgnoreParryPct: input.us.ignoreParryPct,
    otherDamageMult: input.us.damageMult,
    items,
    prior,
  });
  // Their damage was measured against our full DEF. With 35% of it ignored, the same damage came
  // from less ATK, and the simulator is about to apply the piercing itself.
  if (pierce.pierce) {
    const d = input.us.stats.def;
    stats.atk *= (COMBAT.DEF_K + d * 0.65) / (COMBAT.DEF_K + d);
  }
  return fighterModel(opponent, items, stats, inferred.ids, 'medido', 'inferido', inferred.why);
}
