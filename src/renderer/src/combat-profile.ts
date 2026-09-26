import { useEffect, useState } from 'react';
import type { AppSnapshot, SaveState } from '@shared/contracts';
import { COMBAT, buildProfile, currentElementMultiplier, itemSustain, sectorCategories, type EnemyCategory, type PerkMods, type PlayerProfile, type SectorInfo } from '@shared/combat';
import { equippedItems, estimateBuild, type BuildPerks, type PerkStatMods } from '@shared/game-math';
import { mergeMods, withConsumables, type Consumable, type ConsumableMods } from '@shared/consumables';
import { mergePerkCombat, mergePerkStats } from '@shared/perk-mods';
import { CONSUMABLES, ENEMY_CATEGORIES, PERKS, sectorInfo, type PerkInfo } from './catalog';

export interface CombatContext {
  profile: PlayerProfile;
  mods: PerkMods;
  /** 'jogo' = StatsCalculator.GetTotalStats read live (or cached); 'estimado' = our own sum. */
  source: 'jogo' | 'estimado';
  statsAt?: string;
  perkSource: 'jogo' | 'texto';
  perks: PerkInfo[];
  sector: SectorInfo;
  cats: EnemyCategory[];
  regenPct: number[];
  /** average damage multiplier of the current weapons against this sector's mix */
  elementMult: number;
  /** potions running right now; already folded into `profile` */
  potions: Consumable[];
  potionMods: ConsumableMods;
  /** the same build without any potion, for "what would this be worth on its own" */
  profileNoPotions: PlayerProfile;
  /** how many item effects the fight model uses, and how many it cannot */
  effects: { modelled: number; ignored: number; ignoredTexts: string[] };
  state: SaveState;
}

export function combatContext(snapshot: AppSnapshot, sectorIndex?: number): CombatContext | null {
  const state = snapshot.save?.state;
  if (!state) return null;
  const sector = sectorInfo(sectorIndex ?? state.currentSector);
  if (!sector) return null;
  const equippedPerkIds = (state.equippedPerkIds ?? []).filter((id) => id > 0);
  const perks = equippedPerkIds.map((id) => PERKS.find((p) => p.id === id)).filter((p): p is PerkInfo => Boolean(p));
  const liveMods = sameLoadout(snapshot, equippedPerkIds) ? (snapshot.combat.perkMods as PerkMods | undefined) : undefined;
  const mods: PerkMods = liveMods ?? mergePerkCombat(equippedPerkIds);
  const equipped = equippedItems(state).flatMap((e) => (e.item ? [e.item] : []));

  let stats = snapshot.combat.stats;
  let source: CombatContext['source'] = 'jogo';
  // cached live stats go stale when the build changes; trust them only while the level matches
  if (!stats || (snapshot.live.player && snapshot.live.player.level !== state.level)) {
    stats = estimateBuild(state, undefined, { mods: mods as PerkStatMods }).stats;
    source = 'estimado';
  }
  const cats = sectorCategories(sector, ENEMY_CATEGORIES);
  // Potions the player has running are part of the build right now, so the advice reflects them.
  const potions = (state.activeConsumableIds ?? []).map((id) => CONSUMABLES.find((c) => c.id === id)).filter((c): c is Consumable => Boolean(c));
  const potionMods = mergeMods(potions.map((c) => c.mods));
  const sustain = itemSustain(equipped);
  const profileNoPotions = buildProfile(stats, equipped, mods, snapshot.combat.weakBothPct ?? COMBAT.WEAK_BOTH_PCT);
  const profile = withConsumables(profileNoPotions, potionMods);
  return {
    profile,
    profileNoPotions,
    effects: { modelled: sustain.modelled, ignored: sustain.ignored.length, ignoredTexts: sustain.ignored },
    potions,
    potionMods,
    mods,
    source,
    statsAt: snapshot.combat.statsAt,
    perkSource: liveMods ? 'jogo' : 'texto',
    perks,
    sector,
    cats,
    regenPct: snapshot.combat.regenPct?.length ? snapshot.combat.regenPct : COMBAT.REGEN_PCT_BY_SECTOR,
    elementMult: currentElementMultiplier(profile, sector, cats),
    state,
  };
}

/**
 * Runs a heavy synchronous computation after the current frame so the page paints first.
 * Re-runs when `key` changes; stale results are dropped.
 */
export function useDeferred<T>(key: string, compute: () => T): { value: T | null; busy: boolean } {
  const [state, setState] = useState<{ key: string; value: T | null }>({ key: '', value: null });
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      const value = compute();
      if (!cancelled) setState({ key, value });
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // compute is recreated every render; the key is what identifies the work
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { value: state.key === key ? state.value : state.value, busy: state.key !== key };
}

export function profileKey(ctx: CombatContext): string {
  const p = ctx.profile;
  return [ctx.sector.id, p.maxHp, p.atk.toFixed(2), p.def.toFixed(2), p.crit.toFixed(2), p.parry.toFixed(2), p.healPerLandedHit, p.lifestealPct, p.weaponElements.join(','), ctx.regenPct.join('/')].join('|');
}

/**
 * What the perks are worth to a build estimate: the modifiers GetTotalStats applies, and the fixed
 * PWR weight GetPowerScore(stats, state) adds. Live numbers when we have them, our table otherwise.
 */
export function buildPerks(snapshot: AppSnapshot): BuildPerks {
  const ids = (snapshot.save?.state.equippedPerkIds ?? []).filter((id) => id > 0);
  // the live reading only describes the loadout that was equipped when it was taken
  const live = sameLoadout(snapshot, ids) ? (snapshot.combat.perkMods as PerkStatMods | undefined) : undefined;
  const mods = live ?? mergePerkStats(ids);
  const weights = snapshot.combat.perkWeights;
  const weight = ids.reduce((sum, id) => sum + (weights?.[id] ?? PERKS.find((p) => p.id === id)?.psWeight ?? 0), 0);
  return { mods, weight };
}

/** True when the cached PerkModifiers were read with exactly this perk loadout equipped. */
function sameLoadout(snapshot: AppSnapshot, ids: number[]): boolean {
  const seen = snapshot.combat.perkModsIds;
  if (!seen) return false;
  return seen.length === ids.length && seen.every((id, i) => id === ids[i]);
}
