/**
 * A PvP fight, simulated swing by swing with both sides as full profiles.
 *
 * The PvE simulator (`simulateFight`) gives our side every proc we model but fights a monster that
 * is a plain stat block. That is the right model for PvE and the wrong one for the arena, where the
 * other side carries the same kind of gear and perks we do. The losses in our archive are decided
 * exactly there: a parry arming a guaranteed crit (Dawnguard Pendant), the crit healing its owner
 * (Judgment Hammer), Thorns sending half of every hit back. So here both sides run the same rules.
 *
 * Mechanics recovered from the build (re/isil, re/decomp) on top of the PvE ones:
 * - Sudden death: CombatRuntimeEffects.StepTurnAndGetDamageMultiplier. From the 60th swing of the
 *   fight, damage × 1.05^(⌊(swing−60)/10⌋+1), capped at 1000 (.rdata 1.05f / 1000f).
 * - Parry ignore is multiplicative: ResolveAttack does parry × (1 − passiveParryIgnorePct), so
 *   Armor Piercer takes a 55% parry to 35.75%, not to 20%.
 * - Armed mods survive a parried swing: a parry's guaranteed crit waits for the next attack that
 *   lands. 224 of 224 archived hits armed that way critted.
 * - Reflect (Thorns, 50%) is not mitigated by DEF: 30 archived fights show 0.50 of the damage taken
 *   whatever the receiver's DEF.
 * - Last Breath (PerkModifiers.lastBreathFloorPct 0.25): once per fight, a lethal blow leaves 25%.
 * - Rival's Calling +30% damage only in PvP; Colossus Hunter and Coup de Grace only in PvE.
 * - When a blow kills the defender and its reflect kills the attacker, the defender loses: in the
 *   replay against みるふぃーゆ both ended at 0 and the side that was hit lost.
 * - "Every N attacks" (Heavy Lunge, Voracious Echo, items) counts the attacker's own swings that were
 *   NOT parried (playerAttacksMade is incremented after the parry roll) and boosts that same swing;
 *   its "ignores parry" never matters, the roll is already behind it. An "every N hits taken" absorb
 *   counts the same events, so Heavy Lunge's 3rd hit is the one a Frost Colossus Shield swallows —
 *   59 of 59 in the archive.
 * - All pending bonuses (every-N, riposte, first attack) add into one ×(1 + Σ); flat damage is added
 *   after the multipliers, before DEF, sudden death and the defender's damage taken; the on-crit bonus
 *   comes after the absorbs. DEF penetration in PvP caps at 50%.
 * - Bulwark's regeneration is a tick each time the other side swings.
 */
import { applyTurn, emptyTally, type SideTally, type TurnCounts } from './contracts';
import { COMBAT, belowHpAggregate, mergePending, mulberry32, roundHalfEven, type ElementName, type PendingMods, type PlayerProfile } from './combat';

export const PVP = {
  SD_THRESHOLD: 60,
  SD_STEP: 10,
  SD_BASE: 1.05,
  SD_MAX: 1000,
  LAST_BREATH_FLOOR: 0.25,
  RIVALS_CALLING: 1.3,
  /** ResolveAttack: min(pending + passive DEF ignore, 0.5) — 0.75 only with a PvE potion */
  DEF_PEN_CAP: 0.5,
  /** sudden death reaches 1000× long before this; it only guards against a broken profile */
  MAX_SWINGS: 3000,
};

/** Perk ids with PvP-specific behaviour. */
const RIVALS_CALLING = 14;
const LAST_BREATH = 29;

/** The damage multiplier of a given swing, counting every attack of the fight from 1. */
export function suddenDeathMult(swing: number): number {
  if (swing < PVP.SD_THRESHOLD) return 1;
  const k = Math.floor((swing - PVP.SD_THRESHOLD) / PVP.SD_STEP) + 1;
  return Math.min(PVP.SD_MAX, Math.pow(PVP.SD_BASE, k));
}

/** A profile made ready for the arena. */
export interface PvpProfile extends PlayerProfile {
  lastBreath: boolean;
  /** the weapons' elements, kept aside: only a PvP boss has a resistance or weakness to them */
  elementWeapons?: ElementName[];
}

/**
 * Applies what changes between PvE and PvP. Potion effects are dropped: whether consumables apply in
 * the arena is not something the dump settles, so the arena is simulated without them.
 */
export function forPvp(p: PlayerProfile, perkIds: readonly number[]): PvpProfile {
  const ids = new Set(perkIds);
  return {
    ...p,
    damageDealtMult: p.damageDealtMult * (ids.has(RIVALS_CALLING) ? PVP.RIVALS_CALLING : 1),
    enemyDefIgnorePct: 0,
    enemyHpMult: 1,
    executeBelowHpBonus: 0,
    immolationPctPerTurn: 0,
    sunderPerHit: 0,
    ignoreResist: false,
    // elements only matter against monsters and the PvP bosses (arenaOdds applies them per opponent)
    weaponElements: [],
    elementWeapons: p.weaponElements,
    procs: { ...p.procs, enemyMaxHpDamagePct: 0, executeBelowPct: 0 },
    lastBreath: ids.has(LAST_BREATH),
  };
}

type Pending = PendingMods;
const freshPending = (): Pending => ({ damagePct: 0, flat: 0, ignoreDefPct: 0, critPct: 0, crit: false, mult: 1, ignoreParry: false, ignoreDef: false });

interface Fighter {
  p: PvpProfile;
  hp: number;
  attacks: number;
  landed: number;
  crits: number;
  hitsTaken: number;
  pending: Pending;
  critStacks: number;
  risingStacks: number;
  /** "on parry: +N DEF", kept for the fight */
  defBonus: number;
  /** DEF the other side shaved off for good with "on crit: reduces enemy DEF" (no duration) */
  defLoss: number;
  /** the timed ones, and our own timed DEF from parries */
  defDebuffs: Array<{ amount: number; until: number }>;
  parryDefs: Array<{ amount: number; until: number }>;
  /** "Every N sec: +N temporary ATK / DEF / to all stats", piled up this fight */
  timers: Array<{ seconds: number; atk: number; def: number; allStats: number; maxStacks: number; stacks: number }>;
  buffAtk: number;
  buffDef: number;
  buffCrit: number;
  buffParry: number;
  /** poison the other side put on this fighter */
  poisonTurns: number;
  poisonPerTurn: number;
  lastBreath: boolean;
  /** Aggressive Riposte: landed attacks still boosted by the last parry */
  riposteLeft: number;
  /** Blood Curse: overheal kept as a shield, spent before HP */
  shield: number;
}

function fighter(p: PvpProfile): Fighter {
  return {
    p,
    hp: p.maxHp,
    attacks: 0,
    landed: 0,
    crits: 0,
    hitsTaken: 0,
    pending: freshPending(),
    critStacks: 0,
    risingStacks: 0,
    defBonus: 0,
    defLoss: 0,
    defDebuffs: [],
    parryDefs: [],
    timers: p.procs.everyNSec.filter((r) => r.atk || r.def || r.allStats).map((r) => ({ seconds: r.seconds, atk: r.atk, def: r.def, allStats: r.allStats, maxStacks: r.maxStacks ?? 0, stacks: 0 })),
    buffAtk: 0,
    buffDef: 0,
    buffCrit: 0,
    buffParry: 0,
    poisonTurns: 0,
    poisonPerTurn: 0,
    lastBreath: p.lastBreath,
    riposteLeft: 0,
    shield: 0,
  };
}

/** One simulated swing, in the shape the combat log and the tallies already understand. */
export interface DuelTurn extends TurnCounts {
  n: number;
  playerHp: number;
  enemyHp: number;
  suddenDeath: boolean;
}

export interface DuelResult {
  /** true when side `a` (us) is the one left standing */
  won: boolean;
  swings: number;
  aHp: number;
  bHp: number;
  suddenDeath: boolean;
  log?: DuelTurn[];
}

const below = (f: Fighter) => belowHpAggregate(f.p.procs.belowHp, f.hp, f.p.maxHp);

/**
 * Plays one fight. `a` is us and swings first, as in every archived replay.
 */
/** The timed entries still running, dropping the rest (CombatRuntimeEffects' own bookkeeping). */
function activeSum(list: Array<{ amount: number; until: number }>, now: number): number {
  let sum = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.until > now) sum += list[i]!.amount;
    else list.splice(i, 1);
  }
  return sum;
}

export function simulateDuel(a: PvpProfile, b: PvpProfile, rng: () => number, opts: { log?: boolean } = {}): DuelResult {
  const F = [fighter(a), fighter(b)] as const;
  const log: DuelTurn[] | undefined = opts.log ? [] : undefined;
  let sdSeen = false;
  let swing = 0;
  let loser = -1;

  // turn-level bookkeeping, indexed by fighter
  let heal = [0, 0];
  let counter = [0, 0];
  const healF = (i: number, amount: number) => {
    const f = F[i]!;
    if (f.p.disableHealing || amount <= 0 || f.hp <= 0) return;
    const before = f.hp;
    if (f.p.procs.overhealShield && f.hp + amount > f.p.maxHp) f.shield += f.hp + amount - f.p.maxHp;
    f.hp = Math.min(f.p.maxHp, f.hp + amount);
    heal[i]! += f.hp - before;
  };
  /** damage that is not a swing (reflect, counters, poison) */
  const hurt = (i: number, amount: number, by: number) => {
    if (amount <= 0) return;
    F[i]!.hp -= amount;
    counter[by]! += amount;
  };
  const survive = (i: number) => {
    const f = F[i]!;
    if (f.hp <= 0 && f.lastBreath) {
      f.lastBreath = false;
      f.hp = Math.max(1, Math.round(f.p.maxHp * PVP.LAST_BREATH_FLOOR));
    }
  };

  for (; swing < PVP.MAX_SWINGS && loser < 0; ) {
    swing++;
    const ai = (swing - 1) % 2; // attacker index
    const di = 1 - ai;
    const A = F[ai]!;
    const D = F[di]!;
    const x = A.p.procs;
    const y = D.p.procs;
    heal = [0, 0];
    counter = [0, 0];
    const sd = suddenDeathMult(swing);
    if (sd > 1) sdSeen = true;
    const now = (swing - 1) * COMBAT.TURN_SECONDS;

    const u = COMBAT.DMG_MIN + (COMBAT.DMG_MAX - COMBAT.DMG_MIN) * rng();
    A.attacks++;
    const armed = A.pending;
    A.pending = freshPending();
    const bA = below(A);
    const bD = below(D);

    const parryChance = armed.ignoreParry
      ? 0
      : Math.max(0, (Math.min(D.p.parry + D.buffParry, COMBAT.PARRY_CAP) / 100) * (1 - x.ignoreParryPct) - x.enemyCritParryReduction);

    let damage = 0;
    let crit = false;
    let parried = false;

    if (rng() < parryChance) {
      parried = true;
      // a stopped swing keeps what was armed for it (see mergePending)
      A.pending = mergePending(armed, A.pending);
      const op = y.onParry;
      if (op.critNextPct > 0 && rng() < op.critNextPct) D.pending.crit = true;
      if (op.damageNextPct) D.riposteLeft = Math.max(D.riposteLeft, y.riposteHits || 1);
      if (op.flatNext) D.pending.flat += op.flatNext;
      if (op.ignoreParryNext) D.pending.ignoreParry = true;
      if (op.defBonus) D.defBonus += op.defBonus;
      for (const d of y.parryDefBuffs) D.parryDefs.push({ amount: d.amount, until: now + d.seconds });
      if (op.heal) healF(di, op.heal);
      if (op.counter) hurt(ai, op.counter, di);
      if (op.reflectPct) {
        // "reflect N% of the negated damage": what a plain hit would have done
        const negated = (A.p.atk * u * COMBAT.DEF_K) / (COMBAT.DEF_K + Math.max(0, D.p.def));
        hurt(ai, Math.round(negated * op.reflectPct), di);
      }
    } else {
      // the swing got through: it counts for "every N attacks" and "first attack", and a trigger
      // boosts this very swing
      const made = A.landed + 1;
      let evDamage = 0;
      let evFlat = 0;
      let evCrit = 0;
      let evIgnoreDef = 0;
      for (const ev of x.everyNAttacks) {
        if (made % ev.n !== 0) continue;
        evDamage += ev.damagePct;
        evFlat += ev.flat;
        evCrit += ev.critPct;
        evIgnoreDef = Math.max(evIgnoreDef, ev.ignoreDefPct);
      }
      const opening = x.firstAttack && made <= x.firstAttack.hits ? x.firstAttack : null;
      const stacked = x.stackingCrit ? Math.min(A.critStacks * x.stackingCrit.step, x.stackingCrit.max) : 0;
      const critCap = Math.min(A.p.critCap, 100) / 100;
      const critChance = Math.max(0, Math.min((A.p.crit + A.buffCrit) / 100 + armed.critPct + evCrit + stacked, critCap) - y.enemyCritParryReduction);
      crit = !bD?.immuneCrit && (armed.crit || opening?.crit === true || rng() < critChance);

      // AggregatePendingMods: every pending bonus in one ×(1 + Σ)
      const bonus = armed.damagePct + evDamage + (opening?.damagePct ?? 0) + (A.riposteLeft > 0 ? x.onParry.damageNextPct : 0);
      let mult = A.p.damageDealtMult * armed.mult * (1 + bonus);
      if (x.aboveHpDamage && D.hp > x.aboveHpDamage.abovePct * D.p.maxHp) mult *= 1 + x.aboveHpDamage.bonus;
      if (x.risingDamage) mult *= 1 + Math.min(A.risingStacks * x.risingDamage.step, x.risingDamage.max);
      if (bA?.atkPct) mult *= 1 + bA.atkPct;

      const firstHitAtk = x.firstHitTaken?.atkPct && A.hitsTaken > 0 ? 1 + x.firstHitTaken.atkPct : 1;
      const atk = (A.p.atk + A.buffAtk + (bA?.atkFlat ?? 0) + (bA?.allStats ?? 0)) * firstHitAtk;
      const baseDef = Math.max(
        0,
        D.p.def * (1 + (bD?.defPct ?? 0)) + D.defBonus + D.buffDef + activeSum(D.parryDefs, now) + (bD?.allStats ?? 0) - D.defLoss - activeSum(D.defDebuffs, now),
      );
      const pen = Math.min(PVP.DEF_PEN_CAP, x.ignoreDefPct + Math.max(armed.ignoreDefPct, evIgnoreDef));
      const def = armed.ignoreDef ? 0 : baseDef * (1 - pen);
      const critMult = COMBAT.CRIT_MULT * (1 - D.p.enemyCritDamageReduction);
      const flat = A.p.flatDamagePerHit + armed.flat + evFlat;
      damage = Math.max(1, roundHalfEven((atk * u * (crit ? critMult : 1) * mult + flat) * (COMBAT.DEF_K / (COMBAT.DEF_K + def)) * sd * D.p.damageTakenMult));

      D.hitsTaken++;
      let absorb = bD?.absorbPct ?? 0;
      if (y.firstHitTaken && D.hitsTaken <= y.firstHitTaken.hits) absorb = Math.max(absorb, y.firstHitTaken.absorbPct);
      if (y.everyNHitsTaken && D.hitsTaken % y.everyNHitsTaken.n === 0) absorb = Math.max(absorb, y.everyNHitsTaken.absorbPct);
      if (absorb > 0) damage = Math.max(0, Math.round(damage * (1 - Math.min(absorb, 1))));
      // the on-crit bonus lands after the absorb: an "absorbed" crit still hurts
      if (crit && x.onCritFlat) damage += x.onCritFlat;

      if (D.shield > 0) {
        const soaked = Math.min(D.shield, damage);
        D.shield -= soaked;
        damage -= soaked;
      }
      D.hp -= damage;
      survive(di);
      A.landed++;
      if (A.riposteLeft > 0) A.riposteLeft--;
      if (x.risingDamage) A.risingStacks++;
      A.critStacks = crit ? 0 : A.critStacks + 1;

      const steal = (A.p.lifestealPct + (bA?.lifestealPct ?? 0) * 100) / 100;
      healF(ai, A.p.healPerLandedHit + Math.floor(damage * steal) + (bA?.regenPerAttack ?? 0) + (crit ? A.p.healOnCrit + Math.floor(damage * x.onCritHealPctOfDamage) : 0));
      if (x.drainPctOfDamageDealt) A.hp -= Math.round(damage * x.drainPctOfDamageDealt);
      if (y.reflectPct && damage > 0) hurt(ai, Math.max(1, Math.round(damage * y.reflectPct)), di);
      if (y.firstHitTaken?.counter && D.hitsTaken === 1) hurt(ai, y.firstHitTaken.counter, di);

      if (crit) {
        A.crits++;
        for (const d of x.onCritDefDebuff) {
          if (d.seconds > 0) D.defDebuffs.push({ amount: d.amount, until: now + d.seconds });
          else D.defLoss += d.amount;
        }
        if (x.onCritIgnoreDefNext) A.pending.ignoreDef = true;
        if (x.critPoison) {
          D.poisonTurns = Math.ceil(x.critPoison.seconds / COMBAT.TURN_SECONDS);
          D.poisonPerTurn = (x.critPoison.damage * COMBAT.TURN_SECONDS) / x.critPoison.seconds;
        }
        for (const ev of x.everyNCrits) if (A.crits % ev.n === 0) A.pending.mult = Math.max(A.pending.mult, ev.mult);
      }
    }

    // the clock, poison and regeneration run for both sides
    const t = swing * COMBAT.TURN_SECONDS;
    for (let i = 0; i < 2; i++) {
      const f = F[i]!;
      for (const r of f.timers) {
        if (Math.floor(t / r.seconds) > Math.floor((t - COMBAT.TURN_SECONDS) / r.seconds) && (!r.maxStacks || r.stacks < r.maxStacks)) {
          r.stacks++;
          f.buffAtk += r.atk + r.allStats;
          f.buffDef += r.def + r.allStats;
          f.buffCrit += r.allStats;
          f.buffParry += r.allStats;
        }
      }
      if (f.poisonTurns > 0) {
        f.hp -= f.poisonPerTurn;
        f.poisonTurns--;
      }
      for (const r of f.p.regenEvery) {
        if (Math.floor(t / r.seconds) > Math.floor((t - COMBAT.TURN_SECONDS) / r.seconds)) healF(i, r.amount);
      }
      survive(i);
    }

    // Bulwark-like regeneration: a tick for the side that was swung at
    const bd = below(D);
    if (bd?.regenPerSec && D.hp > 0) healF(di, bd.regenPerSec);
    survive(di);

    // the one who took the blow falls first, even when the reflect also finished the attacker
    if (D.hp <= 0) loser = di;
    else if (A.hp <= 0) loser = ai;

    log?.push({
      n: swing,
      playerAttacking: ai === 0,
      damage,
      crit,
      parried,
      healPlayer: heal[0]!,
      healEnemy: heal[1]!,
      counterPlayer: counter[0]!,
      counterEnemy: counter[1]!,
      playerHp: Math.max(0, Math.round(F[0]!.hp)),
      enemyHp: Math.max(0, Math.round(F[1]!.hp)),
      suddenDeath: sd > 1,
    });
  }
  return {
    won: loser === 1 || (loser < 0 && F[0]!.hp >= F[1]!.hp),
    swings: swing,
    aHp: Math.max(0, F[0]!.hp),
    bHp: Math.max(0, F[1]!.hp),
    suddenDeath: sdSeen,
    ...(log ? { log } : {}),
  };
}

export interface DuelOdds {
  win: number;
  /** mean length of a fight, in swings */
  swings: number;
  /** share of fights that reached sudden death */
  suddenDeath: number;
  /**
   * How close the fights were: our HP left minus theirs, as fractions of max HP, averaged (−1 = every
   * fight lost without a scratch on them, +1 = every fight won untouched). It moves when the win
   * chance cannot: a build that loses every fight still loses by less.
   */
  margin: number;
  runs: number;
}

/**
 * Many fights with fixed seeds. The same seeds for every build means two builds face the same
 * dice, so the difference between them is the build and not the luck of the draw.
 */
export function duelOdds(a: PvpProfile, b: PvpProfile, runs = 200, seed = 1): DuelOdds {
  let wins = 0;
  let swings = 0;
  let sd = 0;
  let margin = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulateDuel(a, b, mulberry32(seed * 7919 + i));
    if (r.won) wins++;
    swings += r.swings;
    if (r.suddenDeath) sd++;
    margin += Math.max(0, r.aHp) / Math.max(1, a.maxHp) - Math.max(0, r.bHp) / Math.max(1, b.maxHp);
  }
  return { win: wins / runs, swings: swings / runs, suddenDeath: sd / runs, margin: margin / runs, runs };
}

/** One fight to look at, with its tallies, picked from the same seeds as the odds. */
export function sampleDuel(a: PvpProfile, b: PvpProfile, seed = 1): { result: DuelResult; you: SideTally; them: SideTally } {
  const result = simulateDuel(a, b, mulberry32(seed * 7919), { log: true });
  const you = emptyTally();
  const them = emptyTally();
  for (const t of result.log ?? []) applyTurn(you, them, t);
  return { result, you, them };
}
