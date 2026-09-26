import { useState } from 'react';
import type { AppSnapshot, GameEvent } from '@shared/contracts';
import { EVENT_LABEL, EventRow } from '../events';
import { Empty, FilterChip, Panel } from '../ui';

const FILTERS: Array<{ id: string; label: string; kinds: Array<GameEvent['kind']> | null }> = [
  { id: 'all', label: 'Tudo', kinds: null },
  { id: 'important', label: 'Importantes', kinds: ['level_up', 'drop', 'death', 'sector_change', 'autofight', 'stat_points'] },
  { id: 'drop', label: 'Drops', kinds: ['drop', 'item_removed'] },
  { id: 'battle', label: 'Lutas', kinds: ['battle', 'death', 'battle_paused', 'battle_resumed'] },
  { id: 'pvp', label: 'PvP', kinds: ['pvp'] },
];

export function TimelinePage({ snapshot }: { snapshot: AppSnapshot }) {
  const [filter, setFilter] = useState('important');
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds ?? null;
  const events = snapshot.events.filter((e) => !kinds || kinds.includes(e.kind)).reverse();
  const counts = snapshot.events.reduce<Partial<Record<GameEvent['kind'], number>>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});

  return (
    <Panel
      title="Timeline"
      actions={
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <FilterChip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </FilterChip>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        {Object.entries(counts).map(([k, n]) => (
          <span key={k}>
            {EVENT_LABEL[k as GameEvent['kind']]}: <span className="num font-semibold text-gold">{n}</span>
          </span>
        ))}
      </div>
      {events.length ? (
        <ul className="m-0 list-none p-0">
          {events.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ul>
      ) : (
        <Empty>Nada por aqui ainda.</Empty>
      )}
    </Panel>
  );
}
