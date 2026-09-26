/**
 * Potions. `game-data/consumables.json` carries the catalog the game builds in code
 * (ConsumableCatalog.All, read out of the running process) plus the exact numbers each one applies,
 * decoded from the jump table in ConsumableSystem.GetActiveModifiers (spikes/s6_consumables.py).
 * Nothing here is parsed from the effect text.
 */
import { COMBAT, type PlayerProfile } from './combat';

export type ConsumableCategory = 'Combat' | 'Convenience' | 'Pacing' | 'Loot' | 'Economy';

/** The fields of AutoBattle.Core.ConsumableModifiers, as the game names them. */
export interface ConsumableMods {
  atkPct?: number;
  defPct?: number;
  maxHpPct?: number;
  critFlat?: number;
  parryFlat?: number;
  damageTakenMult?: number;
  lifestealPct?: number;
  ignoreEnemyDefPct?: number;
  endOfFightHealPct?: number;
  enemyHpMult?: number;
  noStamina?: boolean;
  ignoreAllResist?: boolean;
  sunderPerHit?: number;
  executeBelowHpBonus?: number;
  immolationPctPerTurn?: number;
  dropRateBonus?: number;
  xpBonusPct?: number;
  xpFloorPctOfBase?: number;
  higherRarityBonus?: boolean;
  pityThresholdOverride?: number;
}

export interface Consumable {
  id: number;
  name: string;
  category: ConsumableCategory;
  /** the game's own effect text, in the language the player has selected */
  effect: string;
  /** 0 for the instant ones (the Elixirs) */
  durationSec: number;
  mods: ConsumableMods;
}

/** ConsumableModifiers.ignoreEnemyDefPct is capped here ("armor-pen capped at 75% total"). */
export const ARMOR_PEN_CAP = 0.75;

const NUMERIC: Array<keyof ConsumableMods> = [
  'atkPct', 'defPct', 'maxHpPct', 'critFlat', 'parryFlat', 'lifestealPct', 'ignoreEnemyDefPct',
  'endOfFightHealPct', 'sunderPerHit', 'executeBelowHpBonus', 'immolationPctPerTurn', 'dropRateBonus',
  'xpBonusPct',
];
const MULTIPLIED: Array<keyof ConsumableMods> = ['damageTakenMult', 'enemyHpMult'];

/** Several potions can be active at once; the game adds them up and multiplies the mults. */
export function mergeMods(list: ConsumableMods[]): ConsumableMods {
  const out: ConsumableMods = {};
  for (const m of list) {
    for (const k of NUMERIC) {
      const v = m[k] as number | undefined;
      if (v) (out[k] as number) = ((out[k] as number | undefined) ?? 0) + v;
    }
    for (const k of MULTIPLIED) {
      const v = m[k] as number | undefined;
      if (v !== undefined) (out[k] as number) = ((out[k] as number | undefined) ?? 1) * v;
    }
    if (m.noStamina) out.noStamina = true;
    if (m.ignoreAllResist) out.ignoreAllResist = true;
    if (m.higherRarityBonus) out.higherRarityBonus = true;
  }
  return out;
}

/** True when the potion changes nothing the sector simulation models. */
export function affectsCombat(m: ConsumableMods): boolean {
  return [
    m.atkPct, m.defPct, m.maxHpPct, m.critFlat, m.parryFlat, m.lifestealPct, m.ignoreEnemyDefPct,
    m.endOfFightHealPct, m.sunderPerHit, m.executeBelowHpBonus, m.immolationPctPerTurn,
  ].some((v) => Boolean(v)) || m.damageTakenMult !== undefined && m.damageTakenMult !== 1
    || m.enemyHpMult !== undefined && m.enemyHpMult !== 1
    || Boolean(m.ignoreAllResist);
}

/**
 * The profile as it fights with these potions running. Stat percentages hit the final stats the
 * game already computed, which is where ConsumableSystem applies them too — after gear and perks.
 */
export function withConsumables(p: PlayerProfile, m: ConsumableMods): PlayerProfile {
  const regenPct = m.endOfFightHealPct ?? 0;
  return {
    ...p,
    maxHp: Math.round(p.maxHp * (1 + (m.maxHpPct ?? 0))),
    atk: p.atk * (1 + (m.atkPct ?? 0)),
    def: p.def * (1 + (m.defPct ?? 0)),
    crit: p.crit + (m.critFlat ?? 0),
    parry: p.parry + (m.parryFlat ?? 0),
    lifestealPct: p.lifestealPct + (m.lifestealPct ?? 0) * 100,
    damageTakenMult: p.damageTakenMult * (m.damageTakenMult ?? 1),
    regenPerFight: p.regenPerFight + Math.round(p.maxHp * (1 + (m.maxHpPct ?? 0)) * regenPct),
    enemyDefIgnorePct: Math.min(ARMOR_PEN_CAP, p.enemyDefIgnorePct + (m.ignoreEnemyDefPct ?? 0)),
    enemyHpMult: p.enemyHpMult * (m.enemyHpMult ?? 1),
    executeBelowHpBonus: p.executeBelowHpBonus + (m.executeBelowHpBonus ?? 0),
    immolationPctPerTurn: p.immolationPctPerTurn + (m.immolationPctPerTurn ?? 0),
    sunderPerHit: p.sunderPerHit + (m.sunderPerHit ?? 0),
    ignoreResist: p.ignoreResist || Boolean(m.ignoreAllResist),
  };
}

/** A short pt-BR line for what the potion does to a fight, from the numbers rather than the text. */
export function describeMods(m: ConsumableMods): string[] {
  const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 1000) / 10}%`;
  const out: string[] = [];
  if (m.atkPct) out.push(`${pct(m.atkPct)} de ATK`);
  if (m.defPct) out.push(`${pct(m.defPct)} de DEF`);
  if (m.maxHpPct) out.push(`${pct(m.maxHpPct)} de vida máxima`);
  if (m.critFlat) out.push(`+${m.critFlat} de CRIT`);
  if (m.parryFlat) out.push(`+${m.parryFlat} de PARRY`);
  if (m.damageTakenMult !== undefined && m.damageTakenMult !== 1) out.push(`${pct(m.damageTakenMult - 1)} de dano recebido`);
  if (m.lifestealPct) out.push(`rouba ${pct(m.lifestealPct)} do dano como vida`);
  if (m.ignoreEnemyDefPct) out.push(`ignora ${pct(m.ignoreEnemyDefPct)} da DEF do inimigo`);
  if (m.endOfFightHealPct) out.push(`cura ${pct(m.endOfFightHealPct)} da vida máxima por luta vencida`);
  if (m.enemyHpMult !== undefined && m.enemyHpMult !== 1) out.push(`inimigos com ${pct(m.enemyHpMult - 1)} de vida`);
  if (m.sunderPerHit) out.push(`tira ${m.sunderPerHit} de DEF do inimigo a cada 2 acertos`);
  if (m.executeBelowHpBonus) out.push(`${pct(m.executeBelowHpBonus)} de dano abaixo de 50% da vida dele`);
  if (m.immolationPctPerTurn) out.push(`queima ${pct(m.immolationPctPerTurn)} da vida máxima dele por turno (${Math.round((m.immolationPctPerTurn / COMBAT.TURN_SECONDS) * 1000) / 10}%/s)`);
  if (m.ignoreAllResist) out.push('ignora as resistências de elemento');
  if (m.noStamina) out.push('não gasta stamina');
  if (m.dropRateBonus) out.push(`${pct(m.dropRateBonus)} de chance de drop`);
  if (m.xpBonusPct) out.push(`${pct(m.xpBonusPct)} de XP`);
  if (m.higherRarityBonus) out.push('chance de subir a raridade do drop');
  if (m.pityThresholdOverride) out.push(`pity em ${m.pityThresholdOverride} lutas`);
  return out;
}
