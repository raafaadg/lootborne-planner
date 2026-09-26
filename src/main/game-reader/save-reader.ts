import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import type { SaveState } from '@shared/contracts';
import { findSavePath } from './paths';

export interface SaveRead {
  state: SaveState;
  path: string;
  mtimeMs: number;
  sigVersion: number | null;
}

/** Parses the save wrapper `{payload, checksum, sigVersion}`. Read-only: the checksum is never touched. */
export function parseSave(raw: string): { state: SaveState; sigVersion: number | null } {
  const outer = JSON.parse(raw) as { payload?: unknown; sigVersion?: unknown };
  if (typeof outer.payload !== 'string') throw new Error('save without payload');
  const state = JSON.parse(outer.payload) as SaveState;
  if (typeof state.level !== 'number' || !Array.isArray(state.inventory)) throw new Error('unexpected payload shape');
  return { state, sigVersion: typeof outer.sigVersion === 'number' ? outer.sigVersion : null };
}

/**
 * Polls the save's mtime. The game rewrites it after every battle with a .bak rotation, so the file
 * can be briefly missing or half-written: both are retried on the next tick rather than reported.
 */
export class SaveReader extends EventEmitter<{ save: [SaveRead]; error: [string] }> {
  #timer: NodeJS.Timeout | null = null;
  #lastMtime = 0;
  #failures = 0;
  #busy = false;

  constructor(private readonly intervalMs = 500) {
    super();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), this.intervalMs);
    void this.#tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const path = findSavePath();
      if (!path) {
        this.#fail('Save do Lootborne não encontrado');
        return;
      }
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        return; // mid-rotation
      }
      if (mtimeMs === this.#lastMtime) return;
      try {
        const { state, sigVersion } = parseSave(await readFile(path, 'utf8'));
        this.#lastMtime = mtimeMs;
        this.#failures = 0;
        this.emit('save', { state, path, mtimeMs, sigVersion });
      } catch (error) {
        this.#fail(`Falha ao ler o save: ${String(error)}`);
      }
    } finally {
      this.#busy = false;
    }
  }

  #fail(message: string): void {
    // A partial write parses badly once; only report when it persists.
    if (++this.#failures === 6) this.emit('error', message);
  }
}
