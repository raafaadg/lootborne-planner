import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GameEvent } from '@shared/contracts';

/** Append-only event log, one JSONL file per day, kept in userData/history. */
export class History {
  readonly dir: string;

  constructor(userData: string) {
    this.dir = join(userData, 'history');
    mkdirSync(this.dir, { recursive: true });
  }

  append(event: GameEvent): void {
    appendFileSync(join(this.dir, `${event.t.slice(0, 10)}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  /**
   * The most recent `limit` events (of the given kinds, or all) across the newest files. Two copies of the app running at once
   * would each have appended the same event, so identical ones (everything but the id) are dropped.
   */
  recent(limit: number, kinds?: ReadonlySet<GameEvent['kind']>): GameEvent[] {
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: GameEvent[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const lines = readFileSync(join(this.dir, f), 'utf8').trim().split('\n').reverse();
      for (const line of lines) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as GameEvent;
          if (kinds && !kinds.has(event.kind)) continue;
          const { id: _id, ...rest } = event;
          const key = JSON.stringify(rest);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(event);
        } catch {
          // torn last line after a crash
        }
        if (out.length >= limit) return out.reverse();
      }
    }
    return out.reverse();
  }
}
