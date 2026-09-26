/**
 * Talks to the planner's worker.
 *
 * Two rules keep the page calm. Requests are keyed, and only the newest answer is accepted, so a
 * slow ranking cannot overwrite a newer one. And the previous result stays on screen while the next
 * is computing — the numbers are never blank, only stale for a moment, which is what you want when
 * the save rewrites itself every battle.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SaveState } from '@shared/contracts';
import type { GearContext, SlotPicks } from '@shared/gear-advisor';
import type { PlanBuild, PlanOutcome, PlanSettings } from '@shared/plan-eval';
import type { WorkerRequest, WorkerResponse } from './optimizer.worker';

/**
 * The worker is created *in* the effect, not in the render body. StrictMode mounts twice, and a
 * worker built during render outlives the first cleanup: the ref would still point at a terminated
 * worker, which accepts postMessage and answers nothing — the page would sit on "recalculando…"
 * forever. Owning it here means each mount gets a live one.
 */
function useWorker(): Worker | null {
  const [worker, setWorker] = useState<Worker | null>(null);
  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    const w = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    setWorker(w);
    return () => {
      w.terminate();
      setWorker(null);
    };
  }, []);
  return worker;
}

export interface Ranking {
  picks: SlotPicks[];
  /** true while a newer ranking is still being computed; `picks` is the previous one */
  pending: boolean;
  ms: number;
}

/** Ranks every slot against the sector, recomputing only when something that matters changed. */
export function useRanking(state: SaveState | null, ctx: GearContext | null, key: string): Ranking {
  const worker = useWorker();
  const [out, setOut] = useState<{ picks: SlotPicks[]; ms: number }>({ picks: [], ms: 0 });
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!worker || !state || !ctx) return;
    const id = ++seq.current;
    setPending(true);
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== seq.current) return; // a newer request already went out
      worker.removeEventListener('message', onMessage);
      setPending(false);
      if (msg.kind === 'rank') setOut({ picks: msg.picks, ms: msg.ms });
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, kind: 'rank', state, ctx } satisfies WorkerRequest);
    return () => worker.removeEventListener('message', onMessage);
    // `key` is the caller's signature of everything the ranking depends on
  }, [worker, key]);

  return useMemo(() => ({ ...out, pending }), [out, pending]);
}

export interface PlanEval {
  current: PlanOutcome | null;
  /** null when the plan is the equipped build */
  planned: PlanOutcome | null;
  pending: boolean;
  ms: number;
}

export interface PlanRequest {
  state: SaveState;
  current: PlanBuild;
  planned: PlanBuild | null;
  settings: PlanSettings;
  perkTexts?: Record<number, string>;
}

/**
 * The equipped build and the plan, measured side by side in the worker. `key` is the caller's
 * signature of the request; the previous answer stays on screen while a new one is computed.
 */
export function usePlanEval(req: PlanRequest | null, key: string): PlanEval {
  const worker = useWorker();
  const [out, setOut] = useState<{ current: PlanOutcome | null; planned: PlanOutcome | null; ms: number }>({ current: null, planned: null, ms: 0 });
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const latest = useRef(req);
  latest.current = req;

  useEffect(() => {
    if (!worker || !latest.current) return;
    const id = ++seq.current;
    setPending(true);
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== seq.current) return;
      worker.removeEventListener('message', onMessage);
      setPending(false);
      if (msg.kind === 'plan') setOut({ current: msg.current, planned: msg.planned, ms: msg.ms });
    };
    worker.addEventListener('message', onMessage);
    // a short pause: a tank build's laps take seconds to play, and a few quick clicks (a potion, the
    // enemy +5 three times) must not queue a simulation each in the worker
    const timer = setTimeout(() => {
      const r = latest.current;
      if (r && id === seq.current) worker.postMessage({ id, kind: 'plan', ...r } satisfies WorkerRequest);
    }, 300);
    return () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
    };
  }, [worker, key]);

  return useMemo(() => ({ ...out, pending }), [out, pending]);
}
