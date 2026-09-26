/**
 * Turns the shared plan into what the worker measures: the equipped build and the planned one, the
 * sector, where the attempt starts, and the arena. Both pages build it the same way.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppSnapshot, SaveItem, SaveState } from '@shared/contracts';
import { COMBAT, STAT_KEYS, sectorCategories, type EnemyCategory, type SectorInfo } from '@shared/combat';
import type { Consumable } from '@shared/consumables';
import { equippedItems } from '@shared/game-math';
import type { GearContext } from '@shared/gear-advisor';
import { NO_POINTS, type PlanBuild, type PlanSettings } from '@shared/plan-eval';
import type { FighterModel } from '@shared/pvp-opponent';
import { bossForLevel, bossModel } from '@shared/pvp-boss';
import type { PvpBoss } from '@shared/battles';
import type { ArenaSettings } from '@shared/plan-eval';
import { CATALOG_SECTORS, CONSUMABLES, ENEMY_CATEGORIES, PERKS, sectorInfo } from './catalog';
import { ARENA_TARGET, type Plan } from './plan-store';
import type { PlanRequest } from './use-optimizer';

/** Opponents in the arena the PvP line is measured against (the latest ones read exactly). */
export const ARENA_SIZE = 30;

/** The latest ranked opponents as fighters; refreshed when a new fight lands. */
export function useArena(snapshot: AppSnapshot): FighterModel[] {
  const [arena, setArena] = useState<FighterModel[]>([]);
  const latest = snapshot.pvp[0]?.file ?? '';
  useEffect(() => {
    let alive = true;
    void window.planner
      .pvpArena(ARENA_SIZE)
      .then((list) => alive && setArena(list as FighterModel[]))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [latest, snapshot.combat.statsAt]);
  return arena;
}

export interface SlotEntry {
  slot: string;
  /** what is equipped there */
  current: SaveItem | null;
  /** what the plan puts there (the equipped piece when the plan leaves it alone) */
  planned: SaveItem | null;
  changed: boolean;
}

/** The Arena's enemies come from every sector's roster. */
const ARENA_WORLD = { sectors: CATALOG_SECTORS.map((_, i) => sectorInfo(i)!).filter(Boolean), cats: ENEMY_CATEGORIES };

export interface PlanContext {
  state: SaveState;
  sector: SectorInfo;
  /** the Arena is what is measured (the sector stays for the regen table and the farm) */
  arena: ArenaSettings | null;
  cats: EnemyCategory[];
  isCurrentSector: boolean;
  startIndex: number;
  startHp: number | null;
  slots: SlotEntry[];
  equippedPerks: number[];
  plannedPerks: number[];
  activePotions: Consumable[];
  plannedPotions: Consumable[];
  perkWeights: Record<number, number>;
  /** how many things the plan changes */
  changes: number;
  request: PlanRequest;
  key: string;
  /** what the Biblioteca's ranking needs */
  gear: GearContext;
  /** the PvP boss of the level band (the "Vencer o boss" goal), and whether its drop is owned */
  boss: PvpBoss | null;
  bossDefeated: boolean;
  /**
   * The plan written as a save: its items equipped, its perks, its points allocated, and any piece
   * from the Biblioteca in the bag. The optimizer starts from here, so what it proposes is measured
   * against the build on screen.
   */
  planState: SaveState;
  /** seconds left on the potions running in the game (the shortest), null without any */
  currentPotionSeconds: number | null;
}

/** The boss fighter is a pure function of the boss: build it once. */
const bossModels = new Map<number, FighterModel>();
function bossFighter(boss: PvpBoss): FighterModel {
  let m = bossModels.get(boss.index);
  if (!m) bossModels.set(boss.index, (m = bossModel(boss)));
  return m;
}

const potionsOf = (ids: number[]) => ids.map((id) => CONSUMABLES.find((c) => c.id === id)).filter((c): c is Consumable => Boolean(c));
const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function usePlanContext(snapshot: AppSnapshot, plan: Plan, arenaPool: FighterModel[]): PlanContext | null {
  const state = snapshot.save?.state ?? null;
  const liveHp = snapshot.live.player?.hp;
  const combat = snapshot.combat;
  return useMemo(() => {
    if (!state) return null;
    const inArena = plan.sectorId === ARENA_TARGET || (plan.sectorId === null && state.endlessMode);
    const sector = sectorInfo(inArena || plan.sectorId === null ? state.currentSector : plan.sectorId);
    if (!sector) return null;
    const cats = sectorCategories(sector, ENEMY_CATEGORIES);
    const isCurrentSector = inArena ? state.endlessMode : sector.id === state.currentSector && !state.endlessMode;
    const fromHere = plan.fromCurrent && isCurrentSector;
    const startIndex = fromHere && !inArena ? state.sectorEnemy : 0;
    const startHp = fromHere ? (liveHp ?? state.currentHp) : null;
    // the Arena starts at the wave the run is on: from its first kill with full HP, or exactly where it stands
    const arena: ArenaSettings | null = inArena
      ? {
          world: ARENA_WORLD,
          start: {
            wave: Math.max(1, state.waveIndex),
            kills: fromHere ? (state.waveKillCount ?? 0) : 0,
            hp: fromHere ? startHp : null,
            record: state.maxWaveRecord,
            bossMask: state.arenaBossDefeatedMask ?? 0,
            pity: state.killsWithoutDrop,
          },
          hours: plan.arenaHours,
        }
      : null;

    const slots: SlotEntry[] = equippedItems(state).map(({ slot, item }) => {
      const mine = plan.items[slot];
      return { slot, current: item, planned: mine ?? item, changed: Boolean(mine) && mine!.uid !== item?.uid };
    });
    const equippedPerks = (state.equippedPerkIds ?? []).filter((id) => id > 0);
    const plannedPerks = plan.perks ?? equippedPerks;
    const activeIds = state.activeConsumableIds ?? [];
    const plannedIds = plan.potions ?? activeIds;
    const activePotions = potionsOf(activeIds);
    const plannedPotions = potionsOf(plannedIds);
    const perkWeights = combat.perkWeights ?? Object.fromEntries(PERKS.map((p) => [p.id, p.psWeight]));

    const itemChanges = slots.filter((s) => s.changed).length;
    const perkChanged = !sameIds(plannedPerks, equippedPerks);
    const pointsChanged = STAT_KEYS.some((k) => plan.points[k] !== 0);
    const potionsChanged = !sameIds([...plannedIds].sort(), [...activeIds].sort()) || (plan.potions !== null && plannedIds.length > 0 && (plan.potionFrom > 0 || plan.potionDoses > 1));
    const changes = itemChanges + (perkChanged ? 1 : 0) + (pointsChanged ? 1 : 0) + (potionsChanged ? 1 : 0);

    // The potions last a while: the ones running in the game for what the save says is left, the
    // planned ones from the enemy and for the doses the plan says
    const remaining = activeIds.map((id, i) => ({ id, left: state.activeConsumableRemaining?.[i] ?? 0 })).filter((x) => x.left > 0);
    const activeWindow = remaining.length ? { fromIndex: startIndex, seconds: Math.min(...remaining.map((x) => x.left)) } : undefined;
    const doseSeconds = Math.min(...plannedPotions.map((c) => c.durationSec).filter((d) => d > 0), Infinity);
    const plannedWindow =
      plan.potions === null ? activeWindow : Number.isFinite(doseSeconds) ? { fromIndex: plan.potionFrom, seconds: doseSeconds * Math.max(1, plan.potionDoses) } : undefined;
    const current: PlanBuild = { items: slots.flatMap((s) => (s.current ? [s.current] : [])), perkIds: equippedPerks, points: NO_POINTS, potions: activePotions, ...(activeWindow ? { potionWindow: activeWindow } : {}) };
    const planned: PlanBuild | null = changes
      ? { items: slots.flatMap((s) => (s.planned ? [s.planned] : [])), perkIds: plannedPerks, points: plan.points, potions: plannedPotions, ...(plannedWindow ? { potionWindow: plannedWindow } : {}) }
      : null;
    const regenTable = combat.regenPct?.length ? combat.regenPct : COMBAT.REGEN_PCT_BY_SECTOR;
    const boss = bossForLevel(state.level);
    const bossPool = boss ? [bossFighter(boss)] : [];
    const bossDefeated = Boolean(boss && state.inventory.some((i) => i.templateId === boss.dropId));
    const settings: PlanSettings = {
      sector,
      cats,
      regenTable,
      weakBothPct: combat.weakBothPct,
      perkWeights,
      runs: plan.runs,
      startIndex,
      startHp,
      pvpPool: arenaPool,
      bossPool,
      ...(arena ? { arena } : {}),
    };
    const request: PlanRequest = { state, current, planned, settings, perkTexts: combat.perkTexts };
    const key = JSON.stringify([
      state.level,
      state.equippedUids,
      [state.allocatedHp, state.allocatedAtk, state.allocatedDef, state.allocatedCrit, state.allocatedParry],
      equippedPerks,
      activeIds,
      planned && [planned.items.map((i) => i.uid), planned.perkIds, plan.points, plannedIds, planned.potionWindow ?? null],
      current.potionWindow ?? null,
      sector.id,
      plan.runs,
      startIndex,
      startHp,
      arena ? [arena.start, arena.hours] : null,
      arenaPool.length,
      combat.weakBothPct,
      combat.perkEconomyAt ?? '',
    ]);
    const gear: GearContext = {
      sector,
      cats,
      perkIds: plannedPerks,
      perkWeight: plannedPerks.reduce((a, id) => a + (perkWeights[id] ?? 0), 0),
      weakBothPct: combat.weakBothPct,
      regenTable,
      metric: plan.metric,
      pvpPool: arenaPool,
      bossPool,
      perkTexts: combat.perkTexts,
      playerLevel: state.level,
    };
    const extra = slots.flatMap((s) => (s.planned && !state.inventory.some((i) => i.uid === s.planned!.uid) ? [s.planned] : []));
    const planState: SaveState = {
      ...state,
      inventory: extra.length ? [...state.inventory, ...extra] : state.inventory,
      equippedUids: state.equippedSlots.map((slot, i) => slots.find((s) => s.slot === slot)?.planned?.uid ?? state.equippedUids[i] ?? -1),
      equippedPerkIds: plannedPerks,
      allocatedHp: Math.max(0, state.allocatedHp + plan.points.hp),
      allocatedAtk: Math.max(0, state.allocatedAtk + plan.points.atk),
      allocatedDef: Math.max(0, state.allocatedDef + plan.points.def),
      allocatedCrit: Math.max(0, state.allocatedCrit + plan.points.crit),
      allocatedParry: Math.max(0, state.allocatedParry + plan.points.parry),
    };
    return { state, sector, arena, cats, isCurrentSector, startIndex, startHp, slots, equippedPerks, plannedPerks, activePotions, plannedPotions, perkWeights, changes, request, key, gear, boss, bossDefeated, planState, currentPotionSeconds: activeWindow?.seconds ?? null };
  }, [state, plan, arenaPool, liveHp, combat]);
}
