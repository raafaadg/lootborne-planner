/**
 * The planner's arithmetic, off the UI thread.
 *
 * Ranking one slot means re-simulating the whole sector for every candidate item, and the inventory
 * is past 150 pieces — about 190 candidates, each a full run of the sector. On the main thread that
 * is a few hundred milliseconds every time the save is rewritten (once a battle, ~18 s) and again on
 * every click on a metric chip, which is exactly the stutter it looked like. Here it costs nothing
 * visible: the page keeps the last result on screen and swaps it in when this answers.
 */
import type { SaveState } from '@shared/contracts';
import { rankGear, type GearContext, type SlotPicks } from '@shared/gear-advisor';
import { setLivePerkTexts } from '@shared/perk-mods';
import { evaluatePlan, planKey, type PlanBuild, type PlanOutcome, type PlanSettings } from '@shared/plan-eval';
import { deepEvaluate, type DeepContext } from '@shared/deep-eval';
import type { DeepBuild, DeepEval, DeepSchedule } from '@shared/deep-search';

export type WorkerRequest =
  | { id: number; kind: 'rank'; state: SaveState; ctx: GearContext }
  /** the optimizer's pool: the context once, then batches of laps */
  | { id: number; kind: 'mc-init'; ctxId: string; ctx: DeepContext; perkTexts?: Record<number, string> }
  | { id: number; kind: 'mc'; ctxId: string; builds: DeepBuild[]; laps: number; seed: number; schedule: DeepSchedule | null }
  | { id: number; kind: 'plan'; state: SaveState; current: PlanBuild; planned: PlanBuild | null; settings: PlanSettings; perkTexts?: Record<number, string> };

export type WorkerResponse =
  | { id: number; kind: 'rank'; picks: SlotPicks[]; ms: number }
  | { id: number; kind: 'mc-init' }
  | { id: number; kind: 'mc'; evals: DeepEval[]; ms: number }
  | { id: number; kind: 'plan'; current: PlanOutcome; planned: PlanOutcome | null; ms: number }
  | { id: number; kind: 'error'; message: string };

/** The equipped build is measured again only when something it depends on changed. */
const outcomes = new Map<string, PlanOutcome>();
function measure(state: SaveState, b: PlanBuild, s: PlanSettings): PlanOutcome {
  const key = planKey(state, b, s);
  let out = outcomes.get(key);
  if (!out) {
    out = evaluatePlan(state, b, s);
    if (outcomes.size > 24) outcomes.clear();
    outcomes.set(key, out);
  }
  return out;
}

/** The optimizer's context this worker holds (one per run). */
const deepContexts = new Map<string, DeepContext>();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    if (req.kind === 'mc-init') {
      setLivePerkTexts(req.perkTexts);
      deepContexts.clear();
      deepContexts.set(req.ctxId, req.ctx);
      post({ id: req.id, kind: 'mc-init' });
      return;
    }
    if (req.kind === 'mc') {
      const ctx = deepContexts.get(req.ctxId);
      if (!ctx) throw new Error('optimizer context missing');
      post({ id: req.id, kind: 'mc', evals: deepEvaluate(ctx, req.builds, req.laps, req.seed, req.schedule), ms: performance.now() - t0 });
      return;
    }
    // this thread has its own copy of the perk table: give it the game's texts first
    setLivePerkTexts(req.kind === 'rank' ? req.ctx.perkTexts : req.perkTexts);
    if (req.kind === 'rank') {
      const picks = rankGear(req.state, req.ctx);
      post({ id: req.id, kind: 'rank', picks, ms: performance.now() - t0 });
    } else {
      const current = measure(req.state, req.current, req.settings);
      const planned = req.planned ? measure(req.state, req.planned, req.settings) : null;
      post({ id: req.id, kind: 'plan', current, planned, ms: performance.now() - t0 });
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function post(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}
