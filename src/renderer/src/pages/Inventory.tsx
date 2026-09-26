import { useMemo, useState } from 'react';
import { ELEMENTS, ITEM_SLOTS, RARITIES, type AppSnapshot } from '@shared/contracts';
import { upgradeCandidates, inventoryCapForLevel } from '@shared/game-math';
import { buildPerks } from '../combat-profile';
import { Icon } from '../icons';
import { Bar, Chip, Empty, FilterChip, Panel, RarityName, cn, fmt, fmt1 } from '../ui';

type Sort = 'recent' | 'rarity' | 'power';

export function InventoryPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [slot, setSlot] = useState<number | 'all'>('all');
  const [minRarity, setMinRarity] = useState(0);
  const [sort, setSort] = useState<Sort>('power');
  const s = snapshot.save?.state;
  const perks = useMemo(() => buildPerks(snapshot), [snapshot]);
  const deltas = useMemo(() => (s ? new Map(upgradeCandidates(s, perks).map((u) => [u.item.uid, u])) : new Map()), [s, perks]);
  if (!s) return <Empty>Sem save carregado.</Empty>;

  const equipped = new Set(s.equippedUids);
  const cap = inventoryCapForLevel(s.level);
  const rows = s.inventory
    .filter((i) => (slot === 'all' || i.slot === slot) && i.rarity >= minRarity)
    .sort((a, b) =>
      sort === 'recent' ? b.uid - a.uid : sort === 'rarity' ? b.rarity - a.rarity || b.uid - a.uid : (deltas.get(b.uid)?.powerDelta ?? -1e9) - (deltas.get(a.uid)?.powerDelta ?? -1e9),
    );

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Inventário">
        <Bar label="Capacidade da bolsa" value={s.inventory.length} max={cap} color={s.inventory.length >= cap * 0.9 ? 'var(--color-down)' : undefined} right={`${s.inventory.length} / ${cap}`} />
        <div className="flex flex-wrap items-center gap-[7px]">
          <FilterChip on={slot === 'all'} onClick={() => setSlot('all')}>Todos</FilterChip>
          {ITEM_SLOTS.map((name, idx) => (
            <FilterChip key={name} on={slot === idx} onClick={() => setSlot(idx)}>
              {name}
            </FilterChip>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          {RARITIES.map((r, idx) => (
            <FilterChip key={r} on={minRarity === idx} onClick={() => setMinRarity(idx)}>
              <RarityName rarity={idx}>{idx === 0 ? 'Qualquer' : `${r}+`}</RarityName>
            </FilterChip>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          <FilterChip on={sort === 'power'} onClick={() => setSort('power')}>ganho de PWR</FilterChip>
          <FilterChip on={sort === 'rarity'} onClick={() => setSort('rarity')}>raridade</FilterChip>
          <FilterChip on={sort === 'recent'} onClick={() => setSort('recent')}>recentes</FilterChip>
        </div>
      </Panel>
      <Panel title={`${rows.length} itens`}>
        <div className="overflow-x-auto">
          <table className="tabela text-[13px]">
            <thead>
              <tr>
                <th>Item</th>
                <th className="esq">Slot</th>
                <th className="esq">Elemento</th>
                <th>HP</th>
                <th>ATK</th>
                <th>DEF</th>
                <th>CRIT</th>
                <th>PARRY</th>
                <th title="Mudança estimada de PWR ao equipar no melhor slot">Δ PWR</th>
                <th className="esq">Efeitos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const up = deltas.get(i.uid);
                return (
                  <tr key={i.uid}>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Icon family="items" id={i.templateId} title={i.itemName} />
                        <RarityName rarity={i.rarity}>{i.itemName}</RarityName>
                        {equipped.has(i.uid) && <Chip tone="accent">equipado</Chip>}
                        {i.locked && <Chip>travado</Chip>}
                        {i.isNew && <Chip tone="info">novo</Chip>}
                      </div>
                    </td>
                    <td className="esq text-muted">{ITEM_SLOTS[i.slot]}</td>
                    <td className="esq text-muted">{ELEMENTS[i.category] === 'Nessuna' ? '—' : ELEMENTS[i.category]}</td>
                    <td>{fmt(i.hp)}</td>
                    <td>{fmt1(i.atk)}</td>
                    <td>{fmt1(i.def)}</td>
                    <td>{fmt1(i.crit)}</td>
                    <td>{fmt1(i.parry)}</td>
                    <td className={cn('font-semibold', up && up.powerDelta > 0 && 'text-up', up && up.powerDelta < 0 && 'text-muted font-normal')}>
                      {equipped.has(i.uid) ? '—' : up ? `${up.powerDelta > 0 ? '+' : ''}${fmt(up.powerDelta)}` : ''}
                    </td>
                    <td className="esq max-w-[380px] text-xs whitespace-normal text-muted">{i.effects.join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
