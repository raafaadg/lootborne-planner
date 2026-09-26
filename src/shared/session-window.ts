/**
 * A short, live XP window.
 *
 * The session rates in `AppState.stats` are recomputed only when a snapshot goes out — roughly once
 * per save write, every 15–20 s — which is fine for a 30-minute average but wrong for a 10-minute
 * one: with the game paused the figure would sit frozen instead of decaying. So the renderer derives
 * this one itself from the events it already has, against its own clock.
 */
import type { GameEvent } from './contracts';

export const XP_WINDOW_MS = 10 * 60_000;

/** Below this a couple of early fights would extrapolate to an absurd rate, so we withhold it. */
const MIN_SPAN_FOR_RATE_MS = 2 * 60_000;

export interface XpWindow {
  xp: number;
  battles: number;
  /** How long we have actually been counting: the window, or less right after a reset. */
  spanMs: number;
  /** `xp` extrapolated to an hour, or null while the span is too short to mean anything. */
  perHour: number | null;
  /** False while the counter is still filling up, so the UI can say so. */
  full: boolean;
}

/**
 * XP banked in the last `windowMs`, never reaching back past `since` (the moment the counters were
 * last zeroed).
 */
export function xpWindow(events: GameEvent[], since: string | number, now: number, windowMs = XP_WINDOW_MS): XpWindow {
  const start = Math.max(typeof since === 'number' ? since : Date.parse(since), now - windowMs);
  const spanMs = Math.max(0, now - start);
  let xp = 0;
  let battles = 0;
  for (const e of events) {
    if (e.kind !== 'battle' || Date.parse(e.t) < start) continue;
    xp += e.xp;
    battles++;
  }
  return {
    xp,
    battles,
    spanMs,
    perHour: spanMs >= MIN_SPAN_FOR_RATE_MS ? Math.round(xp / (spanMs / 3_600_000)) : null,
    full: spanMs >= windowMs - 30_000,
  };
}
