/**
 * The optimizer's run, kept outside the page: it plays for minutes, so it keeps going while another
 * page is open and shows where it is on the way back. One run at a time; a cancel terminates the pool,
 * which rejects whatever was still out.
 */
import { useSyncExternalStore } from 'react';
import type { DeepContext } from '@shared/deep-eval';
import { deepSearch, type DeepGoal, type DeepInput, type DeepProgress, type DeepResult, type DeepSchedule } from '@shared/deep-search';
import { DeepPool } from './deep-pool';

/** What the page needs to show a result after the plan has moved on. */
export interface RunMeta {
  slots: string[];
  sectorName: string;
  totalEnemies: number;
  startIndex: number;
  /** progress: the schedule the laps were played with */
  schedule: DeepSchedule | null;
  /** the Arena, played for this many hours a run */
  arenaHours?: number;
}

export interface OptimizerRun extends DeepResult, RunMeta {
  seconds: number;
}

export interface OptimizerJob {
  running: boolean;
  goal: DeepGoal | null;
  startedAt: number | null;
  progress: DeepProgress | null;
  log: string[];
  result: OptimizerRun | null;
  error: string | null;
}

let job: OptimizerJob = { running: false, goal: null, startedAt: null, progress: null, log: [], result: null, error: null };
const listeners = new Set<() => void>();
let pool: DeepPool | null = null;
let cancelled = false;

function set(update: Partial<OptimizerJob>): void {
  job = { ...job, ...update };
  for (const l of listeners) l();
}

export function useOptimizerJob(): OptimizerJob {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => job,
  );
}

export async function runOptimizer(input: DeepInput, ctx: DeepContext, meta: RunMeta, perkTexts?: Record<number, string>): Promise<void> {
  if (job.running) return;
  cancelled = false;
  const t0 = Date.now();
  set({ running: true, goal: input.goal, startedAt: t0, progress: null, log: [], result: null, error: null });
  const p = new DeepPool();
  pool = p;
  try {
    await p.init(ctx, perkTexts);
    const r = await deepSearch(input, p.evaluate, {
      chunk: p.size * 4,
      cancelled: () => cancelled,
      progress: (pr) => set({ progress: pr, ...(pr.message ? { log: [...job.log.slice(-7), pr.message] } : {}) }),
    });
    if (!cancelled) set({ result: { ...r, ...meta, seconds: (Date.now() - t0) / 1000 } });
  } catch (e) {
    if (!cancelled) set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    p.terminate();
    pool = null;
    set({ running: false, progress: null });
  }
}

export function cancelOptimizer(): void {
  cancelled = true;
  pool?.terminate();
}

export function clearOptimizerResult(): void {
  if (!job.running) set({ result: null, error: null, log: [] });
}
