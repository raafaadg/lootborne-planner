/**
 * The combat side of item effect texts.
 *
 * The 424 items carry 336 distinct effect strings in 164 shapes. The stat ones (element synergies)
 * are handled in game-math because the game applies them in StatsCalculator; everything here is a
 * *proc*, which the game keeps in CombatRuntimeEffects / PendingAttackMod and only spends while
 * fighting. The texts are partly untranslated (Italian leftovers: "criticto", "danni", "ogni colpo",
 * "per il resto"), so the patterns accept both spellings.
 */

/** The five stats, kept local so this file stays dependency-free like the rest of it. */
export interface StatPct {
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
}

/** Everything a fight needs to know about the equipped items, beyond the stats. */
export interface Procs {
  /** "Every N attacks: +X% damage / +X damage / ignores X% enemy DEF" */
  everyNAttacks: Array<{ n: number; damagePct: number; flat: number; ignoreDefPct: number; critPct: number; ignoreParry?: boolean }>;
  /** "Every N critical hits: next attack deals double|triple|quadruple damage" */
  everyNCrits: Array<{ n: number; mult: number }>;
  /** "On critical hit: +N bonus damage" */
  onCritFlat: number;
  /** "On critical hit: regenerates N HP" */
  onCritHeal: number;
  /** "Your attacks ignore N% of enemy parry" */
  ignoreParryPct: number;
  /** "Your attacks ignore N% of enemy DEF" (the permanent kind) */
  ignoreDefPct: number;
  /** "Reflects N% of damage taken" */
  reflectPct: number;
  /** "On kill: heal N% max HP" */
  onKillHealPct: number;
  /** "First attack of combat is a guaranteed critical" / "+N% damage" */
  firstAttack: { crit: boolean; damagePct: number; hits: number } | null;
  /**
   * "On first hit taken: absorb N% damage" / "First N hits taken: completely absorb" / "counterattack
   * N and +N% ATK for the rest of combat" (the ATK bonus holds from the first hit taken on)
   */
  firstHitTaken: { absorbPct: number; hits: number; counter: number; atkPct: number } | null;
  /** "Every N hits taken: completely absorb the next" (or halve it) */
  everyNHitsTaken: { n: number; absorbPct: number } | null;
  /** "On parry: ..." */
  onParry: { counter: number; heal: number; defBonus: number; critNextPct: number; damageNextPct: number; reflectPct: number; flatNext: number; ignoreParryNext: boolean };
  /** how many landed attacks the on-parry damage bonus lasts: Aggressive Riposte's text says 2 */
  riposteHits: number;
  /** "healing above max HP becomes a temporary shield" (Blood Curse): overheal is kept as a shield */
  overhealShield: boolean;
  /** "Below X% HP: ..." — the strongest matching threshold wins while we are under it */
  belowHp: Array<BelowHp>;
  /**
   * "Every N sec: +N temporary ATK / +N DEF / +N to all stats / regenerates N HP". The stat ones pile
   * up for the whole fight (CombatRuntimeEffects.TickTemporaryBuffs adds on every tick) and start
   * over at the next; "(max N stack)" caps them. "All stats" is ATK, DEF, CRIT and PARRY.
   */
  everyNSec: Array<{ seconds: number; atk: number; def: number; allStats: number; hp: number; maxStacks: number }>;
  /**
   * "On parry: +N DEF per N sec": each parry pushes a DEF buff that runs out
   * (CombatRuntimeEffects.PushTimedDefBuffOnParry). The "for the rest of combat" kind is onParry.defBonus.
   */
  parryDefBuffs: Array<{ amount: number; seconds: number }>;
  /** "Lifesteal N%" */
  lifestealPct: number;
  /** "Reduces enemy critical damage by N%" */
  enemyCritDamageReduction: number;
  /** "Regeneration: +N HP" at the end of a fight */
  regenPerFight: number;
  /** "Convert N% of max HP into ATK" */
  hpToAtkPct: number;
  /** "Reduces enemy critical and parry by N%" */
  enemyCritParryReduction: number;
  /**
   * "On critical hit: reduces enemy DEF by N for|per N sec": every crit pushes its own debuff and
   * the enemy loses the sum of the ones still running (PushOnCritEnemyDefDebuff /
   * GetActiveEnemyDefReduction). seconds 0: no duration in the text, kept for the fight.
   */
  onCritDefDebuff: Array<{ amount: number; seconds: number }>;
  /** "On criticto hit: next attack ignores DEF" */
  onCritIgnoreDefNext: boolean;
  /** "On criticto hit: absorb N% damage come HP" */
  onCritHealPctOfDamage: number;
  /** "On kill: +N% damage for the rest of combat, up to N stacks" */
  onKillDamageStack: { pct: number; max: number } | null;
  /** "Critical hits apply a poison dealing N damage over N sec, ignoring DEF" */
  critPoison: { damage: number; seconds: number } | null;
  /** "+N% damage to enemies above N% HP" */
  aboveHpDamage: { abovePct: number; bonus: number } | null;
  // ---- perk mechanics that live in the same place (see perk-mods.ts) ----
  /** Pent-Up Wrath:每 non-crit hit stacks CRIT, reset on a crit */
  stackingCrit: { step: number; max: number } | null;
  /** Rising Momentum: each landed attack adds damage, reset each fight */
  risingDamage: { step: number; max: number } | null;
  /** Colossus Hunter: every hit also takes this share of the enemy's max HP */
  enemyMaxHpDamagePct: number;
  /** Coup de Grace: enemies below this share of their HP die outright */
  executeBelowPct: number;
  /** Blood Curse: this share of the damage we deal comes off our own HP */
  drainPctOfDamageDealt: number;
  /**
   * StatsCalculator.CalcUnconditionalStatPct — "+25% DEF and +10% HP", "+18% ATK, -10% DEF".
   * Signed percentages of our own stats. GetTotalStats does NOT apply these (it only runs the two
   * synergy passes), so they never show up in PWR; the fight applies them.
   */
  statPct: StatPct;
  /** StatsCalculator.CalcAllStatsPerOtherEquippedItem — "+1 to all stats for every other equipped item" */
  allStatsPerOtherItem: number;
  /** how many effect texts we understood, and the ones we did not */
  modelled: number;
  ignored: string[];
}

export interface BelowHp {
  pct: number;
  atkPct: number;
  atkFlat: number;
  defPct: number;
  allStats: number;
  lifestealPct: number;
  regenPerSec: number;
  regenPerAttack: number;
  absorbPct: number;
  immuneCrit: boolean;
}

export function emptyProcs(): Procs {
  return {
    everyNAttacks: [],
    everyNCrits: [],
    onCritFlat: 0,
    onCritHeal: 0,
    ignoreParryPct: 0,
    ignoreDefPct: 0,
    reflectPct: 0,
    onKillHealPct: 0,
    firstAttack: null,
    firstHitTaken: null,
    everyNHitsTaken: null,
    onParry: { counter: 0, heal: 0, defBonus: 0, critNextPct: 0, damageNextPct: 0, reflectPct: 0, flatNext: 0, ignoreParryNext: false },
    riposteHits: 0,
    overhealShield: false,
    belowHp: [],
    everyNSec: [],
    parryDefBuffs: [],
    lifestealPct: 0,
    enemyCritDamageReduction: 0,
    regenPerFight: 0,
    hpToAtkPct: 0,
    enemyCritParryReduction: 0,
    onCritDefDebuff: [],
    onCritIgnoreDefNext: false,
    onCritHealPctOfDamage: 0,
    onKillDamageStack: null,
    critPoison: null,
    aboveHpDamage: null,
    stackingCrit: null,
    risingDamage: null,
    enemyMaxHpDamagePct: 0,
    executeBelowPct: 0,
    drainPctOfDamageDealt: 0,
    statPct: { hp: 0, atk: 0, def: 0, crit: 0, parry: 0 },
    allStatsPerOtherItem: 0,
    modelled: 0,
    ignored: [],
  };
}

/** Effects StatsCalculator turns into plain stats; game-math already applies them. */
const STAT_SYNERGY =
  /^(For (?:every|each) other |For every different element category |If equipped with |If dual wielding |[+-][\d.]+%?\s*(?:ATK|DEF|HP|CRIT|PARRY)\b|[+-][\d.]+\s*to all stats)/i;

/** Effects that never touch a fight: stamina, drops, currency. */
const OUT_OF_COMBAT = /stamina|bonus item chance|rarity drop|Bloodmarks|in Rest/i;

/** CalcUnconditionalStatPct's own gate and pattern, copied from the game's regexes. */
const PCT_GATE = /^\s*[+-]\d/;
const PCT_STAT = /([+-])(\d+(?:\.\d+)?)%\s*(ATK|DEF|HP|CRIT|PARRY)\b/g;
const ALL_STATS_PER_ITEM = /\+(\d+)\s+to\s+all\s+stats\s+for\s+every\s+other\s+equipped\s+item/i;

const PCT_KEY: Record<string, keyof StatPct> = { HP: 'hp', ATK: 'atk', DEF: 'def', CRIT: 'crit', PARRY: 'parry' };

/**
 * The two families StatsCalculator keeps out of GetTotalStats and reads at fight time:
 * CalcUnconditionalStatPct and CalcAllStatsPerOtherEquippedItem.
 */
function parseUnconditional(p: Procs, text: string): boolean {
  let hit = false;
  const all = text.match(ALL_STATS_PER_ITEM);
  if (all) {
    p.allStatsPerOtherItem += Number(all[1]);
    hit = true;
  }
  if (PCT_GATE.test(text)) {
    PCT_STAT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PCT_STAT.exec(text))) {
      const key = PCT_KEY[m[3]!.toUpperCase()];
      if (key) {
        p.statPct[key] += (m[1] === '-' ? -1 : 1) * (Number(m[2]) / 100);
        hit = true;
      }
    }
  }
  return hit;
}

const num = (v: string | undefined, fallback = 0) => (v === undefined ? fallback : Number(v));
/** the word in prose: "critical", and the untranslated "criticto" the game ships */
const CRIT = 'critic\\w*';
/** the stat itself, always written CRIT */
const CRIT_STAT = 'CRIT\\b';

function belowHpEntry(list: BelowHp[], pct: number): BelowHp {
  let entry = list.find((b) => b.pct === pct);
  if (!entry) {
    entry = { pct, atkPct: 0, atkFlat: 0, defPct: 0, allStats: 0, lifestealPct: 0, regenPerSec: 0, regenPerAttack: 0, absorbPct: 0, immuneCrit: false };
    list.push(entry);
  }
  return entry;
}

/** Reads the "Below X% HP: ..." clause, which chains several bonuses with "and". */
function parseBelowHp(p: Procs, pct: number, rest: string): void {
  const b = belowHpEntry(p.belowHp, pct);
  let m: RegExpMatchArray | null;
  if ((m = rest.match(/\+(\d+(?:\.\d+)?)%\s*ATK/i))) b.atkPct += Number(m[1]) / 100;
  if ((m = rest.match(/\+(\d+(?:\.\d+)?)\s*ATK\b(?!%)/i)) && !/%\s*ATK/i.test(rest)) b.atkFlat += Number(m[1]);
  if ((m = rest.match(/\+(\d+(?:\.\d+)?)%\s*(?:temporary\s+|permanent\s+)?DEF/i))) b.defPct += Number(m[1]) / 100;
  if ((m = rest.match(/\+(\d+(?:\.\d+)?)\s*to all stats/i))) b.allStats += Number(m[1]);
  if ((m = rest.match(/lifesteal\s+(\d+(?:\.\d+)?)%/i))) b.lifestealPct += Number(m[1]) / 100;
  // The game's own pattern: "regenerates N HP" followed by /sec, "per sec", a comma, a full stop, a
  // bracket or the end of the text is per second. Bulwark's combat text is the bare form ("absorb
  // 42% damage and regenerates 8 HP") and is worth 8 HP/sec — not the 4 its description shows.
  const perAttack = /(?:ogni (?:colpo|attacco|critico)|每)\s*regenerates?|regenerates?\s+\d+(?:\.\d+)?\s*HP\s*(?:per attack|per ogni attacco)/i.test(rest);
  if (!perAttack && (m = rest.match(/regenerates?\s+(\d+(?:\.\d+)?)\s*HP(?:\s*\/\s*sec|\s+per\s+sec|\s*$|\s*,|\.|\s*\()/i))) b.regenPerSec += Number(m[1]);
  if ((m = rest.match(/regenerates?\s+(\d+(?:\.\d+)?)\s*HP\s*(?:per attack|per ogni attacco)/i))) b.regenPerAttack += Number(m[1]);
  if ((m = rest.match(/(?:ogni (?:colpo|attacco)|每)\s*regenerates?\s+(\d+)\s*HP/i))) b.regenPerAttack += Number(m[1]);
  if ((m = rest.match(/absorb\s+(\d+(?:\.\d+)?)%\s*damage/i))) b.absorbPct += Number(m[1]) / 100;
  if (new RegExp(`immune (?:to|a) ${CRIT}`, 'i').test(rest)) b.immuneCrit = true;
}

/** One item effect line; returns false when nothing in it is a combat proc we model. */
function parseOne(p: Procs, text: string): boolean {
  const e = text.trim();
  let m: RegExpMatchArray | null;

  // Blood Curse's combat text (StatsCalculator.CalcOverhealShield)
  if (/healing above max HP becomes a (?:temporary )?shield|overheal becomes a shield/i.test(e)) {
    p.overhealShield = true;
    return true;
  }

  // ---- attack counters -------------------------------------------------------------------
  if ((m = e.match(/^Every\s+(\d+)\s+attacks?:\s*(.+)$/i))) {
    const n = Number(m[1]);
    const rest = m[2]!;
    const entry: Procs['everyNAttacks'][number] = { n, damagePct: 0, flat: 0, ignoreDefPct: 0, critPct: 0 };
    let hit = false;
    let x: RegExpMatchArray | null;
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)%\s*damage/i))) {
      entry.damagePct = Number(x[1]) / 100;
      hit = true;
    }
    // Heavy Lunge and Voracious Echo: "... and ignores parry" (the whole parry, not a share of it)
    if (/ignores?\s+parry\b/i.test(rest)) {
      entry.ignoreParry = true;
      hit = true;
    }
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)\s*(?:bonus damage|damage\b(?!\s*%)|danni)/i))) {
      entry.flat = Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/ignor\w*\s+(\d+(?:\.\d+)?)%\s*(?:enemy\s+)?DEF/i))) {
      entry.ignoreDefPct = Number(x[1]) / 100;
      hit = true;
    }
    if ((x = rest.match(new RegExp(`\\+(\\d+(?:\\.\\d+)?)%\\s*${CRIT_STAT}`, 'i')))) {
      entry.critPct = Number(x[1]) / 100;
      hit = true;
    }
    if (hit) {
      p.everyNAttacks.push(entry);
      return true;
    }
    return false; // e.g. "+N% CRIT for N turns", which we do not track yet
  }

  // ---- critical counters -----------------------------------------------------------------
  if ((m = e.match(new RegExp(`^Every\\s+(\\d+)\\s+${CRIT}(?:\\s+\\w+)?\\s+(?:hits?|attacks?):\\s*next attack deals (double|triple|quadruple)`, 'i')))) {
    p.everyNCrits.push({ n: Number(m[1]), mult: { double: 2, triple: 3, quadruple: 4 }[m[2]!.toLowerCase()] ?? 2 });
    return true;
  }

  // ---- on critical hit -------------------------------------------------------------------
  if ((m = e.match(new RegExp(`^On ${CRIT} hit:\\s*(.+)$`, 'i')))) {
    const rest = m[1]!;
    let hit = false;
    let x: RegExpMatchArray | null;
    if ((x = rest.match(/(?:\+|deals\s+)(\d+(?:\.\d+)?)\s*(?:bonus damage|danni bonus|damage)/i))) {
      p.onCritFlat += Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/regenerates?\s+(\d+)\s*HP/i))) {
      p.onCritHeal += Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/reduces enemy DEF by\s+(\d+)(?:\s+(?:for|per)\s+(\d+)\s*sec)?/i))) {
      p.onCritDefDebuff.push({ amount: Number(x[1]), seconds: x[2] ? Number(x[2]) : 0 });
      hit = true;
    }
    if (/next attack ignores DEF/i.test(rest)) {
      p.onCritIgnoreDefNext = true;
      hit = true;
    }
    if ((x = rest.match(/absorb\s+(\d+(?:\.\d+)?)%\s*damage come HP/i))) {
      p.onCritHealPctOfDamage += Number(x[1]) / 100;
      hit = true;
    }
    return hit;
  }

  // ---- permanent penetration -------------------------------------------------------------
  if ((m = e.match(/^Your attacks ignore\s+(\d+(?:\.\d+)?)%\s*(?:of\s+)?enemy parry(?:\s+and\s+(\d+(?:\.\d+)?)%\s*(?:of\s+)?enemy DEF)?/i))) {
    p.ignoreParryPct += Number(m[1]) / 100;
    if (m[2]) p.ignoreDefPct += Number(m[2]) / 100;
    return true;
  }

  // ---- reflect, kill, conversion ----------------------------------------------------------
  if ((m = e.match(/^Reflects\s+(\d+(?:\.\d+)?)%\s*of damage taken/i))) {
    p.reflectPct += Number(m[1]) / 100;
    return true;
  }
  if ((m = e.match(/^On kill:\s*heal\s+(\d+(?:\.\d+)?)%\s*max HP/i))) {
    p.onKillHealPct += Number(m[1]) / 100;
    return true;
  }
  if ((m = e.match(/^Convert\s+(\d+(?:\.\d+)?)%\s*of max HP into ATK/i))) {
    p.hpToAtkPct += Number(m[1]) / 100;
    return true;
  }

  // ---- opening attacks --------------------------------------------------------------------
  if ((m = e.match(/^First\s+(\d+)?\s*attacks?\s+of combat\s+(?:deals?|deal)\s*\+(\d+(?:\.\d+)?)%\s*damage(.*)$/i))) {
    p.firstAttack = {
      crit: new RegExp(`guaranteed ${CRIT}`, 'i').test(m[3] ?? ''),
      damagePct: Number(m[2]) / 100,
      hits: num(m[1], 1),
    };
    return true;
  }
  if (new RegExp(`^First attack of combat is a guaranteed ${CRIT}`, 'i').test(e)) {
    p.firstAttack = { crit: true, damagePct: 0, hits: 1 };
    return true;
  }

  // ---- taking the first hits ---------------------------------------------------------------
  if ((m = e.match(/^(?:On first hit taken|On first hit|First hit taken damage reduced by|First\s+(\d+)\s+hits? taken)[:\s]*(.*)$/i))) {
    const hits = num(m[1], 1);
    const rest = `${m[2] ?? ''} ${e}`;
    let absorbPct = 0;
    let counter = 0;
    let atkPct = 0;
    let x: RegExpMatchArray | null;
    if (/completely absorb/i.test(rest)) absorbPct = 1;
    else if ((x = rest.match(/(?:absorb|reduced by)\s+(\d+(?:\.\d+)?)%/i))) absorbPct = Number(x[1]) / 100;
    if ((x = rest.match(/(?:counterattack\w*|contrattacca)\s*(?:for\s*|con\s*)?(\d+)/i))) counter = Number(x[1]);
    // "... and +20% ATK for the rest of combat" / "ottieni +20% ATK per il resto"
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)%\s*ATK/i))) atkPct = Number(x[1]) / 100;
    if (absorbPct || counter || atkPct) {
      p.firstHitTaken = { absorbPct, hits, counter, atkPct };
      return true;
    }
    return false;
  }
  if ((m = e.match(/^Every\s+(\d+)\s+hits? taken:\s*(.+)$/i))) {
    const rest = m[2]!;
    const absorbPct = /completely absorb/i.test(rest) ? 1 : /halved/i.test(rest) ? 0.5 : 0;
    if (absorbPct) {
      p.everyNHitsTaken = { n: Number(m[1]), absorbPct };
      return true;
    }
    return false;
  }

  // ---- parry ------------------------------------------------------------------------------
  if ((m = e.match(/^On parry:\s*(.+)$/i))) {
    const rest = m[1]!;
    let hit = false;
    let x: RegExpMatchArray | null;
    if ((x = rest.match(/(?:counterattack\w*|contrattacca)\s*(?:for\s*|con\s*)?(\d+)/i))) {
      p.onParry.counter += Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/regenerates?\s+(\d+)\s*HP/i))) {
      p.onParry.heal += Number(x[1]);
      hit = true;
    }
    // "+N DEF per|for N sec" runs out; "+N DEF for the rest of combat" / "per il resto" does not
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)\s*DEF(?:\s+(?:per|for)\s+(\d+)\s*sec)?/i))) {
      if (x[2]) p.parryDefBuffs.push({ amount: Number(x[1]), seconds: Number(x[2]) });
      else p.onParry.defBonus += Number(x[1]);
      hit = true;
    }
    // "next attack ha 100% CRIT", "+10% CRIT to next attack", "next attack ha +30% CRIT"
    if ((x = rest.match(new RegExp(`(?:next attack ha\\w*\\s*|\\+)\\+?(\\d+(?:\\.\\d+)?)%\\s*${CRIT_STAT}`, 'i')))) {
      p.onParry.critNextPct = Math.max(p.onParry.critNextPct, Number(x[1]) / 100);
      hit = true;
    }
    if ((x = rest.match(/deals?\s+(\d+)\s*(?:danni bonus|bonus damage)/i))) {
      p.onParry.flatNext += Number(x[1]);
      hit = true;
    }
    if (/ignore\w*\s+parry/i.test(rest)) {
      p.onParry.ignoreParryNext = true;
      hit = true;
    }
    if ((x = rest.match(/next\s+(?:(\d+)\s+)?attacks?\s+(?:[^+]*?)\+(\d+(?:\.\d+)?)%\s*damage/i))) {
      p.onParry.damageNextPct += Number(x[2]) / 100;
      p.riposteHits = Math.max(p.riposteHits, x[1] ? Number(x[1]) : 1);
      hit = true;
    }
    if ((x = rest.match(/reflect\s+(\d+(?:\.\d+)?)%\s*of the negated damage/i))) {
      p.onParry.reflectPct += Number(x[1]) / 100;
      hit = true;
    }
    return hit;
  }

  // ---- below a health threshold -------------------------------------------------------------
  if ((m = e.match(/^Below\s+(\d+(?:\.\d+)?)%\s*HP:\s*(.+)$/i))) {
    const before = JSON.stringify(p.belowHp);
    parseBelowHp(p, Number(m[1]) / 100, m[2]!);
    return JSON.stringify(p.belowHp) !== before;
  }

  // ---- timers -------------------------------------------------------------------------------
  if ((m = e.match(/^Every\s+(\d+)\s+sec(?:\s+in combat)?:\s*(.+)$/i))) {
    const seconds = Number(m[1]);
    const rest = m[2]!;
    const entry = { seconds, atk: 0, def: 0, allStats: 0, hp: 0, maxStacks: 0 };
    let hit = false;
    let x: RegExpMatchArray | null;
    if ((x = rest.match(/regenerates?\s+(\d+)\s*HP/i))) {
      entry.hp = Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)\s*(?:temporary\s+|permanent\s+)?ATK/i))) {
      entry.atk = Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)\s*(?:temporary\s+|permanent\s+)?DEF/i))) {
      entry.def = Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/\+(\d+(?:\.\d+)?)\s*to all stats/i))) {
      entry.allStats = Number(x[1]);
      hit = true;
    }
    if ((x = rest.match(/max\s+(\d+)\s*stacks?/i))) entry.maxStacks = Number(x[1]);
    if (hit) {
      p.everyNSec.push(entry);
      return true;
    }
    return false;
  }

  // ---- enemy debuffs and the odd ones out -----------------------------------------------------
  if ((m = e.match(new RegExp(`^Reduces enemy ${CRIT} and parry by\\s+(\\d+(?:\\.\\d+)?)%`, 'i')))) {
    p.enemyCritParryReduction += Number(m[1]) / 100;
    return true;
  }
  if ((m = e.match(new RegExp(`^On ${CRIT} hit:\\s*reduces enemy DEF by\\s+(\\d+)(?:\\s+(?:for|per)\\s+(\\d+)\\s*sec)?`, 'i')))) {
    p.onCritDefDebuff.push({ amount: Number(m[1]), seconds: m[2] ? Number(m[2]) : 0 });
    return true;
  }
  if ((m = e.match(/^On kill:\s*\+(\d+(?:\.\d+)?)%\s*damage for the rest of combat,\s*up to\s+(\d+)\s*stacks/i))) {
    p.onKillDamageStack = { pct: Number(m[1]) / 100, max: Number(m[2]) };
    return true;
  }
  if ((m = e.match(new RegExp(`^${CRIT} hits apply a poison dealing\\s+(\\d+)\\s*damage over\\s+(\\d+)\\s*sec`, 'i')))) {
    p.critPoison = { damage: Number(m[1]), seconds: Number(m[2]) };
    return true;
  }
  if ((m = e.match(/^\+(\d+(?:\.\d+)?)%\s*damage to enemies above\s+(\d+(?:\.\d+)?)%\s*HP/i))) {
    p.aboveHpDamage = { bonus: Number(m[1]) / 100, abovePct: Number(m[2]) / 100 };
    return true;
  }

  // ---- plain, always-on numbers ---------------------------------------------------------------
  if ((m = e.match(/^Lifesteal\s+(\d+(?:\.\d+)?)%/i))) {
    p.lifestealPct += Number(m[1]);
    return true;
  }
  if ((m = e.match(new RegExp(`^Reduces enemy ${CRIT}(?:\\s+and parry)? damage by\\s+(\\d+(?:\\.\\d+)?)%`, 'i')))) {
    p.enemyCritDamageReduction += Number(m[1]) / 100;
    return true;
  }
  if ((m = e.match(/Regeneration:\s*\+(\d+)\s*HP/i))) {
    p.regenPerFight += Number(m[1]);
    return true;
  }
  return false;
}

/** Reads every effect string of the equipped items into one proc set. */
export function parseProcs(effects: string[]): Procs {
  const p = emptyProcs();
  for (const text of effects) {
    // These two look like stat lines but GetTotalStats never applies them, so they belong here and
    // have to be read before the synergy skip swallows them.
    if (parseUnconditional(p, text)) {
      p.modelled++;
      continue;
    }
    if (STAT_SYNERGY.test(text)) continue; // applied as stats, not here
    if (parseOne(p, text)) p.modelled++;
    else if (!OUT_OF_COMBAT.test(text)) p.ignored.push(text);
  }
  p.enemyCritDamageReduction = Math.min(p.enemyCritDamageReduction, 0.9);
  p.ignoreParryPct = Math.min(p.ignoreParryPct, 1);
  p.ignoreDefPct = Math.min(p.ignoreDefPct, 0.75);
  p.enemyCritParryReduction = Math.min(p.enemyCritParryReduction, 1);
  // the deepest threshold first, so the fight can pick the strongest one that applies
  p.belowHp.sort((a, b) => a.pct - b.pct);
  return p;
}

/** Short pt-BR labels for what the equipped items add to a fight, straight from the parsed numbers. */
export function describeProcs(p: Procs): string[] {
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  const out: string[] = [];
  for (const ev of p.everyNAttacks) {
    const parts = [ev.damagePct && `+${pct(ev.damagePct)} de dano`, ev.flat && `+${ev.flat} de dano`, ev.ignoreDefPct && `ignora ${pct(ev.ignoreDefPct)} da DEF`, ev.critPct && `+${pct(ev.critPct)} de CRIT`].filter(Boolean);
    out.push(`a cada ${ev.n} ataques: ${parts.join(', ')}`);
  }
  for (const ev of p.everyNCrits) out.push(`a cada ${ev.n} críticos: próximo golpe ×${ev.mult}`);
  if (p.onCritFlat) out.push(`crítico: +${p.onCritFlat} de dano`);
  if (p.onCritHeal) out.push(`crítico: cura ${p.onCritHeal} PV`);
  for (const d of p.onCritDefDebuff) out.push(`crítico: -${d.amount} de DEF do inimigo${d.seconds ? ` por ${d.seconds}s` : ''}`);
  for (const d of p.parryDefBuffs) out.push(`ao aparar: +${d.amount} de DEF por ${d.seconds}s`);
  if (p.onCritIgnoreDefNext) out.push('crítico: próximo golpe ignora a DEF');
  if (p.onCritHealPctOfDamage) out.push(`crítico: cura ${pct(p.onCritHealPctOfDamage)} do dano`);
  if (p.critPoison) out.push(`crítico: veneno de ${p.critPoison.damage} em ${p.critPoison.seconds}s`);
  if (p.ignoreParryPct) out.push(`ignora ${pct(p.ignoreParryPct)} do parry do inimigo`);
  if (p.ignoreDefPct) out.push(`ignora ${pct(p.ignoreDefPct)} da DEF do inimigo`);
  if (p.reflectPct) out.push(`reflete ${pct(p.reflectPct)} do dano recebido`);
  if (p.enemyCritDamageReduction) out.push(`-${pct(p.enemyCritDamageReduction)} do dano crítico inimigo`);
  if (p.enemyCritParryReduction) out.push(`-${pct(p.enemyCritParryReduction)} de CRIT e PARRY do inimigo`);
  if (p.onKillHealPct) out.push(`ao matar: cura ${pct(p.onKillHealPct)} da vida máxima`);
  if (p.onKillDamageStack) out.push(`ao matar: +${pct(p.onKillDamageStack.pct)} de dano (até ${p.onKillDamageStack.max}x)`);
  if (p.overhealShield) out.push('cura acima do máximo vira escudo');
  if (p.aboveHpDamage) out.push(`+${pct(p.aboveHpDamage.bonus)} de dano acima de ${pct(p.aboveHpDamage.abovePct)} da vida dele`);
  if (p.firstAttack) out.push(`${p.firstAttack.hits === 1 ? 'primeiro golpe' : `${p.firstAttack.hits} primeiros golpes`}: ${[p.firstAttack.crit && 'crítico garantido', p.firstAttack.damagePct && `+${pct(p.firstAttack.damagePct)} de dano`].filter(Boolean).join(' e ')}`);
  if (p.firstHitTaken) out.push(`${p.firstHitTaken.hits === 1 ? 'primeiro golpe recebido' : `${p.firstHitTaken.hits} primeiros golpes recebidos`}: ${[p.firstHitTaken.absorbPct && `absorve ${pct(p.firstHitTaken.absorbPct)}`, p.firstHitTaken.counter && `contra-ataca ${p.firstHitTaken.counter}`, p.firstHitTaken.atkPct && `+${pct(p.firstHitTaken.atkPct)} de ATK até o fim da luta`].filter(Boolean).join(' e ')}`);
  if (p.everyNHitsTaken) out.push(`a cada ${p.everyNHitsTaken.n} golpes recebidos: absorve ${pct(p.everyNHitsTaken.absorbPct)}`);
  const op = p.onParry;
  const parry = [op.critNextPct && `${pct(op.critNextPct)} de crítico no próximo`, op.damageNextPct && `+${pct(op.damageNextPct)} de dano ${p.riposteHits > 1 ? `nos próximos ${p.riposteHits}` : 'no próximo'}`, op.flatNext && `+${op.flatNext} de dano no próximo`, op.counter && `contra-ataca ${op.counter}`, op.heal && `cura ${op.heal} PV`, op.defBonus && `+${op.defBonus} de DEF`, op.ignoreParryNext && 'próximo ignora parry', op.reflectPct && `reflete ${pct(op.reflectPct)}`].filter(Boolean);
  if (parry.length) out.push(`ao aparar: ${parry.join(', ')}`);
  for (const b of p.belowHp) {
    const parts = [b.atkPct && `+${pct(b.atkPct)} de ATK`, b.atkFlat && `+${b.atkFlat} de ATK`, b.defPct && `+${pct(b.defPct)} de DEF`, b.allStats && `+${b.allStats} em tudo`, b.lifestealPct && `rouba ${pct(b.lifestealPct)}`, b.regenPerSec && `+${b.regenPerSec} PV/s`, b.regenPerAttack && `+${b.regenPerAttack} PV por golpe`, b.absorbPct && `absorve ${pct(b.absorbPct)}`, b.immuneCrit && 'imune a críticos'].filter(Boolean);
    if (parts.length) out.push(`abaixo de ${pct(b.pct)} de vida: ${parts.join(', ')}`);
  }
  for (const t of p.everyNSec) {
    const parts = [t.hp && `+${t.hp} PV`, t.atk && `+${t.atk} de ATK`, t.def && `+${t.def} de DEF`, t.allStats && `+${t.allStats} em tudo`].filter(Boolean);
    out.push(`a cada ${t.seconds}s: ${parts.join(', ')}`);
  }
  if (p.lifestealPct) out.push(`rouba ${p.lifestealPct}% do dano como vida`);
  if (p.regenPerFight) out.push(`+${p.regenPerFight} PV por luta vencida`);
  if (p.hpToAtkPct) out.push(`converte ${pct(p.hpToAtkPct)} da vida máxima em ATK`);
  return out;
}

/** Folds a partial proc set (a perk's, say) into one parsed from items. */
export function mergeProcs(base: Procs, extra: Partial<Procs>): Procs {
  const out: Procs = { ...base, onParry: { ...base.onParry }, belowHp: [...base.belowHp] };
  out.everyNAttacks = [...base.everyNAttacks, ...(extra.everyNAttacks ?? [])];
  out.everyNCrits = [...base.everyNCrits, ...(extra.everyNCrits ?? [])];
  out.everyNSec = [...base.everyNSec, ...(extra.everyNSec ?? [])];
  out.parryDefBuffs = [...base.parryDefBuffs, ...(extra.parryDefBuffs ?? [])];
  out.onCritDefDebuff = [...base.onCritDefDebuff, ...(extra.onCritDefDebuff ?? [])];
  for (const b of extra.belowHp ?? []) {
    const hit = out.belowHp.find((x) => x.pct === b.pct);
    if (!hit) out.belowHp.push({ ...b });
    else {
      hit.atkPct += b.atkPct;
      hit.atkFlat += b.atkFlat;
      hit.defPct += b.defPct;
      hit.allStats += b.allStats;
      hit.lifestealPct += b.lifestealPct;
      hit.regenPerSec += b.regenPerSec;
      hit.regenPerAttack += b.regenPerAttack;
      hit.absorbPct += b.absorbPct;
      hit.immuneCrit ||= b.immuneCrit;
    }
  }
  out.belowHp.sort((a, b) => a.pct - b.pct);
  for (const k of ['onCritFlat', 'onCritHeal', 'ignoreParryPct', 'ignoreDefPct', 'reflectPct', 'onKillHealPct', 'lifestealPct', 'enemyCritDamageReduction', 'regenPerFight', 'hpToAtkPct', 'enemyCritParryReduction', 'onCritHealPctOfDamage', 'enemyMaxHpDamagePct', 'executeBelowPct', 'drainPctOfDamageDealt'] as const) {
    out[k] = base[k] + (extra[k] ?? 0);
  }
  out.executeBelowPct = Math.max(base.executeBelowPct, extra.executeBelowPct ?? 0);
  out.onCritIgnoreDefNext = base.onCritIgnoreDefNext || Boolean(extra.onCritIgnoreDefNext);
  out.firstAttack = extra.firstAttack ?? base.firstAttack;
  out.firstHitTaken = extra.firstHitTaken ?? base.firstHitTaken;
  out.everyNHitsTaken = extra.everyNHitsTaken ?? base.everyNHitsTaken;
  out.onKillDamageStack = extra.onKillDamageStack ?? base.onKillDamageStack;
  out.critPoison = extra.critPoison ?? base.critPoison;
  out.aboveHpDamage = extra.aboveHpDamage ?? base.aboveHpDamage;
  out.stackingCrit = extra.stackingCrit ?? base.stackingCrit;
  out.risingDamage = extra.risingDamage ?? base.risingDamage;
  if (extra.onParry) {
    const p = extra.onParry;
    out.onParry.counter += p.counter;
    out.onParry.heal += p.heal;
    out.onParry.defBonus += p.defBonus;
    out.onParry.flatNext += p.flatNext;
    out.onParry.reflectPct += p.reflectPct;
    out.onParry.critNextPct = Math.max(out.onParry.critNextPct, p.critNextPct);
    // each copy pushes its own pending mod (Mirror Echo behind Aggressive Riposte, or two items)
    out.onParry.damageNextPct += p.damageNextPct;
    out.onParry.ignoreParryNext ||= p.ignoreParryNext;
  }
  out.riposteHits = Math.max(base.riposteHits, extra.riposteHits ?? 0);
  out.overhealShield = base.overhealShield || Boolean(extra.overhealShield);
  out.ignoreParryPct = Math.min(out.ignoreParryPct, 1);
  out.ignoreDefPct = Math.min(out.ignoreDefPct, 0.75);
  return out;
}
