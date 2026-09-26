import { useEffect, useState } from 'react';
import type { AppSnapshot } from '@shared/contracts';
import { setLivePerkTexts } from '@shared/perk-mods';

export function useSnapshot(): AppSnapshot | null {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const take = (s: AppSnapshot) => {
      // the perk model reads the game's own combat texts when the live tap has them
      setLivePerkTexts(s.combat.perkTexts);
      setSnapshot(s);
    };
    void window.planner.getSnapshot().then((s) => alive && take(s));
    const off = window.planner.onSnapshot(take);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return snapshot;
}

/** Re-renders every `ms` so relative times ("há 12s") stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
