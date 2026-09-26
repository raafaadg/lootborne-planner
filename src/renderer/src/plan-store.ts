/**
 * The build being planned, shared by the Simulador and the Biblioteca: a piece tried in the library
 * shows up in the simulator's plan and the other way round. It lives for the session only — the
 * game is never touched, and a plan is cheap to rebuild.
 */
import { useSyncExternalStore } from 'react';
import type { SaveItem } from '@shared/contracts';
import type { GearMetric } from '@shared/gear-advisor';
import { NO_POINTS, type Points } from '@shared/plan-eval';

export interface Plan {
  /** slot name ("Arma 1") → the piece planned there; the slots not listed keep what is equipped */
  items: Record<string, SaveItem>;
  /** the perk loadout; null = the one equipped */
  perks: number[] | null;
  /**
   * stat points against the allocated ones: added on top, or — with `respec` — also taken off a stat
   * (negative), as the game's respec lets you lay every point out again
   */
  points: Points;
  respec: boolean;
  /** potions; null = the ones running in the game */
  potions: number[] | null;
  /** when the planned potions go down in a lap (enemy index) and how many doses back to back */
  potionFrom: number;
  potionDoses: number;
  /** simulation settings: the sector (null = the current one; ARENA_TARGET = the Arena) */
  sectorId: number | null;
  /** hours of autofight the Arena is played for */
  arenaHours: number;
  fromCurrent: boolean;
  runs: number;
  metric: GearMetric;
}

/** `sectorId` for the Arena */
export const ARENA_TARGET = -1;

const INITIAL: Plan = { items: {}, perks: null, points: NO_POINTS, respec: false, potions: null, potionFrom: 0, potionDoses: 1, sectorId: null, arenaHours: 4, fromCurrent: false, runs: 1000, metric: 'farm' };

let plan: Plan = INITIAL;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPlan(update: (p: Plan) => Plan): void {
  plan = update(plan);
  for (const l of listeners) l();
}

/** Back to the equipped build; the simulation settings stay. */
export function resetPlan(): void {
  setPlan((p) => ({ ...p, items: {}, perks: null, points: NO_POINTS, respec: false, potions: null, potionFrom: 0, potionDoses: 1 }));
}

export function usePlan(): Plan {
  return useSyncExternalStore(subscribe, () => plan);
}
