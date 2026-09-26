/**
 * What a PvP replay tells us about the two fighters.
 *
 * Two independent sources, kept apart on purpose:
 *  - the gear: the replay names every equipped item, and item stats are fixed per template, so the
 *    catalog gives their exact contribution (synergy effects included);
 *  - the turns: inverting the damage formula on ~20 hits per side measures the ATK and DEF that
 *    were actually in play, perks and elements included.
 * The gap between the two is what points and perks added.
 */
import {
  ELEMENTS,
  ITEM_SLOTS,
  type CatalogItem,
  type Element,
  type PvpFighter,
  type PvpGear,
  type PvpTurn,
  type Rarity,
  type SaveItem,
} from './contracts';
import { COMBAT } from './combat';
import { BASE_STATS, PER_POINT, addStats, emptyStats, powerScore, synergyBonus, type Stats } from './game-math';

/** Checked against the save: allocated + unspent == (level - 1) * 5. */
export const POINTS_PER_LEVEL = 5;

/** sd of the U(0.8, 1.2) damage roll, relative to its mean. */
const ROLL_SD = 0.4 / Math.sqrt(12);

export interface GearPiece extends PvpGear {
  item: CatalogItem | null;
}

export interface FighterBuild {
  fighter: PvpFighter;
  pieces: GearPiece[];
  /** pieces whose name is not in our catalog (new item, renamed, older build) */
  unknown: number;
  itemStats: Stats;
  synergy: Stats;
  /** base + items + synergy: everything before allocated points and perks */
  gear: Stats;
  /** stat points the level grants: (level - 1) * 5 */
  points: number;
  /** points in HP, implied by the max HP the replay records (perks that scale HP land here too) */
  hpPoints: number;
  effects: string[];
  weapons: Element[];
}

export function toSaveItem(piece: GearPiece, uid: number): SaveItem | null {
  const it = piece.item;
  if (!it) return null;
  return {
    uid,
    templateId: it.id,
    itemName: it.name,
    slot: Math.max(0, ITEM_SLOTS.indexOf(it.slot as (typeof ITEM_SLOTS)[number])),
    rarity: 0,
    category: Math.max(0, ELEMENTS.indexOf(it.element)),
    hp: it.hp,
    atk: it.atk,
    def: it.def,
    crit: it.crit,
    parry: it.parry,
    effects: it.effects,
    isNew: false,
    locked: false,
    isBossExclusive: it.isBossExclusive,
    grantSource: 0,
  };
}

/** A replay fighter's gear as the save items the combat code works with. */
export function fighterItems(fighter: PvpFighter, byName: Map<string, CatalogItem>): SaveItem[] {
  return fighter.gear
    .map((g, i) => toSaveItem({ ...g, item: byName.get(g.name) ?? null }, i + 1))
    .filter((i): i is SaveItem => i !== null);
}

/** Rebuilds what the fighter's gear was worth, using the catalog (item stats are fixed per name). */
export function fighterBuild(fighter: PvpFighter, byName: Map<string, CatalogItem>): FighterBuild {
  const pieces: GearPiece[] = fighter.gear.map((g) => ({ ...g, item: byName.get(g.name) ?? null }));
  const items = pieces.map((p, i) => toSaveItem(p, i + 1)).filter((i): i is SaveItem => i !== null);
  const itemStats = items.reduce((acc, i) => addStats(acc, i), emptyStats());
  const syn = synergyBonus(items);
  const gear = addStats(addStats(addStats(emptyStats(), BASE_STATS), itemStats), syn.bonus);
  const points = Math.max(0, (fighter.level - 1) * POINTS_PER_LEVEL);
  const hpPoints = Math.max(0, Math.round((fighter.maxHp - gear.hp) / PER_POINT.hp));
  return {
    fighter,
    pieces,
    unknown: pieces.filter((p) => p.name && !p.item).length,
    itemStats,
    synergy: syn.bonus,
    gear,
    points,
    hpPoints,
    effects: pieces.flatMap((p) => p.item?.effects ?? []),
    weapons: pieces.filter((p) => p.slot.startsWith('Arma')).map((p) => p.element),
  };
}

/**
 * Stats we assume for a fighter before looking at the turns: gear plus the level's points, with HP
 * pinned to the replay's max HP and the rest split the way `hint` splits them.
 */
export function assumedStats(build: FighterBuild, hint: Partial<Stats> = {}): Stats {
  const rest = Math.max(0, build.points - build.hpPoints);
  const w = { atk: hint.atk ?? 0, def: hint.def ?? 0, crit: hint.crit ?? 0, parry: hint.parry ?? 0 };
  const total = w.atk + w.def + w.crit + w.parry;
  const share = total > 0 ? w : { atk: 1, def: 1, crit: 1, parry: 1 };
  const sum = total > 0 ? total : 4;
  return {
    hp: build.fighter.maxHp,
    atk: build.gear.atk + (rest * share.atk) / sum * PER_POINT.atk,
    def: build.gear.def + (rest * share.def) / sum * PER_POINT.def,
    crit: build.gear.crit + (rest * share.crit) / sum * PER_POINT.crit,
    parry: build.gear.parry + (rest * share.parry) / sum * PER_POINT.parry,
  };
}

export interface Measured {
  /** ATK behind the damage this side dealt, given the other side's DEF. Elements and perks included. */
  atk: number | null;
  atkMargin: number;
  /** DEF this side showed, given the other side's ATK. */
  def: number | null;
  defMargin: number;
  critPct: number | null;
  parryPct: number | null;
  /** HP this side healed per landed hit of its own (Crimson Vow and friends) */
  healPerHit: number;
  /** how much of the damage it took came back as a counter-attack */
  counterPct: number | null;
  landed: number;
  attacks: number;
  /** plain average damage of a landed hit, crits included as they landed */
  meanHit: number;
}

interface Sample {
  /** mean damage with crits normalised to a plain hit */
  mean: number;
  /** mean damage as it landed */
  meanRaw: number;
  landed: number;
  attacks: number;
  crits: number;
  parriedByOther: number;
  heal: number;
  counter: number;
  damageTaken: number;
}

function sample(turns: PvpTurn[], player: boolean): Sample {
  let sum = 0;
  let raw = 0;
  let landed = 0;
  let attacks = 0;
  let crits = 0;
  let parried = 0;
  let heal = 0;
  let counter = 0;
  let taken = 0;
  for (const t of turns) {
    if (t.playerAttacking === player) {
      attacks++;
      if (t.parried) parried++;
      else {
        landed++;
        raw += t.damage;
        sum += t.damage / (t.crit ? COMBAT.CRIT_MULT : 1);
        if (t.crit) crits++;
      }
      heal += player ? t.healPlayer : t.healEnemy;
    } else if (!t.parried) {
      taken += t.damage;
      counter += player ? t.counterPlayer : t.counterEnemy;
    }
  }
  return { mean: landed ? sum / landed : 0, meanRaw: landed ? raw / landed : 0, landed, attacks, crits, parriedByOther: parried, heal, counter, damageTaken: taken };
}

/** dmg = ATK * u * 60/(60+DEF)  =>  ATK = mean * (60+DEF)/60 */
function atkFrom(mean: number, defOther: number): number {
  return (mean * (COMBAT.DEF_K + defOther)) / COMBAT.DEF_K;
}

/** the same inversion the other way round */
function defFrom(mean: number, atkOther: number): number {
  return mean > 0 ? (COMBAT.DEF_K * atkOther) / mean - COMBAT.DEF_K : 0;
}

function measure(s: Sample, other: Sample, defOther: number, atkOther: number): Measured {
  const rel = s.landed ? ROLL_SD / Math.sqrt(s.landed) : 1;
  const atk = s.landed ? atkFrom(s.mean, defOther) : null;
  const def = other.landed ? defFrom(other.mean, atkOther) : null;
  const defRel = other.landed ? ROLL_SD / Math.sqrt(other.landed) : 1;
  return {
    atk,
    atkMargin: atk === null ? 0 : atk * rel,
    def,
    // d(DEF)/d(mean) = -(60+DEF)/mean, so the relative error grows with the DEF itself
    defMargin: def === null ? 0 : (COMBAT.DEF_K + def) * defRel,
    critPct: s.landed ? (s.crits / s.landed) * 100 : null,
    // the other side parried these
    parryPct: other.attacks ? (other.parriedByOther / other.attacks) * 100 : null,
    healPerHit: s.landed ? s.heal / s.landed : 0,
    counterPct: s.damageTaken > 0 ? (s.counter / s.damageTaken) * 100 : null,
    landed: s.landed,
    attacks: s.attacks,
    meanHit: s.meanRaw,
  };
}

export interface SideAnalysis {
  build: FighterBuild;
  /** what we assume before the turns (gear + points) */
  assumed: Stats;
  measured: Measured;
  /** best guess: measured where we have it, assumed otherwise */
  stats: Stats;
  power: number;
  /** points the measurement implies, per stat (perks land here too) */
  impliedPoints: Partial<Stats>;
}

export interface ReplayAnalysis {
  you: SideAnalysis;
  them: SideAnalysis;
  /** our own stats came from the live tap, not from a guess */
  exactPlayerStats: boolean;
  turns: number;
}

export interface AnalysisContext {
  byName: Map<string, CatalogItem>;
  /** how we spend points today, used to split the opponent's unknown points */
  allocation?: Partial<Stats>;
  /** our current stats from the live tap; only trusted when max HP still matches the replay */
  playerStats?: Stats;
  /** our perk multipliers (PerkCombat.GetPerkModifiers), applied when we rebuild our own stats */
  playerPerks?: { atkPct?: number; defPct?: number; atkFlat?: number; critFlat?: number };
}

/** Our own build at the time of the fight: the replay's gear, today's point split, our perks. */
function playerStatsFor(build: FighterBuild, ctx: AnalysisContext): Stats {
  const s = assumedStats(build, ctx.allocation);
  const p = ctx.playerPerks;
  if (!p) return s;
  return {
    hp: s.hp,
    atk: (s.atk + (p.atkFlat ?? 0)) * (1 + (p.atkPct ?? 0)),
    def: s.def * (1 + (p.defPct ?? 0)),
    crit: s.crit + (p.critFlat ?? 0),
    parry: s.parry,
  };
}

/** Inverts the combat formula on both sides of one fight. Needs the turn log. */
export function analyzeReplay(
  player: PvpFighter,
  opponent: PvpFighter,
  turns: PvpTurn[],
  ctx: AnalysisContext,
): ReplayAnalysis {
  const youBuild = fighterBuild(player, ctx.byName);
  const themBuild = fighterBuild(opponent, ctx.byName);
  const exact = Boolean(ctx.playerStats && Math.abs(ctx.playerStats.hp - player.maxHp) <= 1);
  // Our own side is never inferred: either the game told us, or we rebuild it from the replay's
  // gear. It is the anchor, because inverting both sides at once has no unique answer.
  const youAssumed = exact ? { ...ctx.playerStats! } : playerStatsFor(youBuild, ctx);
  const themAssumed = assumedStats(themBuild, ctx.allocation);

  const youSample = sample(turns, true);
  const themSample = sample(turns, false);
  const themMeasured = measure(themSample, youSample, youAssumed.def, youAssumed.atk);
  // Only the directly observed part of our side is meaningful; ATK/DEF here would just give the
  // anchor back, so they are dropped.
  const youMeasured: Measured = { ...measure(youSample, themSample, 0, 0), atk: null, def: null, atkMargin: 0, defMargin: 0 };

  const side = (build: FighterBuild, assumed: Stats, m: Measured, ownAtk: number | null): SideAnalysis => {
    const stats: Stats = {
      hp: build.fighter.maxHp,
      atk: ownAtk ?? assumed.atk,
      def: m.def ?? assumed.def,
      crit: m.critPct ?? assumed.crit,
      parry: m.parryPct ?? assumed.parry,
    };
    return {
      build,
      assumed,
      measured: m,
      stats,
      power: powerScore(stats),
      impliedPoints: {
        hp: build.hpPoints,
        atk: Math.max(0, Math.round((stats.atk - build.gear.atk) / PER_POINT.atk)),
        def: Math.max(0, Math.round((stats.def - build.gear.def) / PER_POINT.def)),
        crit: Math.max(0, Math.round((stats.crit - build.gear.crit) / PER_POINT.crit)),
        parry: Math.max(0, Math.round((stats.parry - build.gear.parry) / PER_POINT.parry)),
      },
    };
  };

  const you = side(youBuild, youAssumed, youMeasured, youAssumed.atk);
  // our own DEF and CRIT come from the build, not from the fight's small sample
  you.stats = { ...youAssumed };
  you.power = powerScore(you.stats);
  return {
    you,
    them: side(themBuild, themAssumed, themMeasured, themMeasured.atk),
    exactPlayerStats: exact,
    turns: turns.length,
  };
}

export interface OpponentRecord {
  name: string;
  fights: number;
  wins: number;
  losses: number;
  friendly: number;
  lastAt: string;
  lastLevel: number;
  maxHp: number;
}

/** Head-to-head record per opponent across the whole archive. */
export function opponentRecords(
  history: Array<{ opponent: { name: string; level: number; maxHp: number }; won: boolean; friendly: boolean; t: string }>,
): OpponentRecord[] {
  const out = new Map<string, OpponentRecord>();
  for (const r of history) {
    const rec = out.get(r.opponent.name) ?? {
      name: r.opponent.name,
      fights: 0,
      wins: 0,
      losses: 0,
      friendly: 0,
      lastAt: r.t,
      lastLevel: r.opponent.level,
      maxHp: r.opponent.maxHp,
    };
    rec.fights++;
    if (r.friendly) rec.friendly++;
    if (r.won) rec.wins++;
    else rec.losses++;
    if (r.t > rec.lastAt) {
      rec.lastAt = r.t;
      rec.lastLevel = r.opponent.level;
      rec.maxHp = r.opponent.maxHp;
    }
    out.set(rec.name, rec);
  }
  return [...out.values()].sort((a, b) => b.fights - a.fights || b.lastAt.localeCompare(a.lastAt));
}

export function rarityOf(gear: PvpGear[]): Partial<Record<Rarity, number>> {
  const out: Partial<Record<Rarity, number>> = {};
  for (const g of gear) out[g.rarity] = (out[g.rarity] ?? 0) + 1;
  return out;
}
