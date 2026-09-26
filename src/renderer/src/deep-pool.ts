/**
 * A pool of workers for the optimizer: it plays thousands of laps a round, so the batches are split
 * across the machine's cores. Each worker gets the context once (`mc-init`), then batches.
 * `terminate` rejects whatever is still out, which is how a cancel ends the search.
 */
import type { DeepBuild, DeepEval, DeepSchedule } from '@shared/deep-search';
import type { DeepContext } from '@shared/deep-eval';
import type { WorkerRequest, WorkerResponse } from './optimizer.worker';

export function poolSize(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(2, Math.min(8, cores - 1));
}

export class DeepPool {
  private readonly workers: Worker[];
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (m: WorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly ctxId = `opt-${Date.now()}`;
  private dead = false;

  constructor(size = poolSize()) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
      w.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.kind === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      });
      return w;
    });
  }

  get size(): number {
    return this.workers.length;
  }

  private send(w: Worker, msg: WorkerRequest): Promise<WorkerResponse> {
    if (this.dead) return Promise.reject(new Error('cancelada'));
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      w.postMessage(msg);
    });
  }

  async init(ctx: DeepContext, perkTexts?: Record<number, string>): Promise<void> {
    await Promise.all(this.workers.map((w) => this.send(w, { id: ++this.seq, kind: 'mc-init', ctxId: this.ctxId, ctx, perkTexts })));
  }

  /** the builds split across the workers, the results back in order */
  evaluate = async (builds: DeepBuild[], laps: number, seed: number, schedule: DeepSchedule | null): Promise<DeepEval[]> => {
    if (!builds.length) return [];
    const n = Math.min(this.workers.length, builds.length);
    const per = Math.ceil(builds.length / n);
    const parts = await Promise.all(
      Array.from({ length: n }, (_, k) => {
        const chunk = builds.slice(k * per, (k + 1) * per);
        if (!chunk.length) return Promise.resolve([] as DeepEval[]);
        return this.send(this.workers[k]!, { id: ++this.seq, kind: 'mc', ctxId: this.ctxId, builds: chunk, laps, seed, schedule }).then((m) => (m.kind === 'mc' ? m.evals : []));
      }),
    );
    return parts.flat();
  };

  terminate(): void {
    this.dead = true;
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('cancelada'));
    this.pending.clear();
  }
}
