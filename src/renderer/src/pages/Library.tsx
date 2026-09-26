import { useMemo, useState } from 'react';
import { ELEMENTS, ITEM_SLOTS, RARITIES, type AppSnapshot, type CatalogItem, type SaveItem } from '@shared/contracts';
import { affectsCombat, describeMods } from '@shared/consumables';
import { isShield } from '@shared/game-math';
import type { GearMetric, GearPick } from '@shared/gear-advisor';
import { perkModelStatus } from '@shared/perk-mods';
import { catalogAsItem, isCatalogItem } from '@shared/plan-eval';
import { CATALOG_ITEMS, CONSUMABLES, PERKS } from '../catalog';
import { METRICS, PerkBadges, StatusTable, SurvivalChart, SwapCard, itemStats, perkInfo, pickHeadline, potionDuration } from '../build-parts';
import { Icon } from '../icons';
import { ARENA_SIZE, useArena, usePlanContext, type PlanContext } from '../plan-context';
import { resetPlan, setPlan, usePlan } from '../plan-store';
import { usePlanEval, useRanking } from '../use-optimizer';
import { Button, Chip, Empty, FilterChip, Panel, cn, fmt, rarityColor } from '../ui';

type Tab = 'items' | 'perks' | 'potions';
type Sort = 'gain' | 'rarity' | 'name';
const PAGE = 60;
/** Sixteen arena opponents make a catalog-wide ranking far too slow; one boss is fine. */
const LIB_METRICS = METRICS.filter((m) => m.id !== 'pvp');

/**
 * Every item, perk and potion in the game, each one a click away from being tried on the character.
 * What is tried goes into the same plan the Simulador edits, and the panel on the right measures it
 * against the equipped build: survival curve and the status table.
 */
export function LibraryPage({ snapshot, onOpenSimulator }: { snapshot: AppSnapshot; onOpenSimulator: () => void }) {
  const plan = usePlan();
  const arena = useArena(snapshot);
  const pc = usePlanContext(snapshot, plan, arena);
  const ev = usePlanEval(pc?.request ?? null, pc?.key ?? 'none');
  const [tab, setTab] = useState<Tab>('items');

  if (!pc) return <Empty>Sem save carregado.</Empty>;
  const cur = ev.current;
  const next = ev.planned;
  const scope = { bossName: pc.boss?.name, sectorName: pc.sector.name, totalEnemies: pc.sector.totalEnemies, runs: plan.runs, startIndex: pc.startIndex, startHp: pc.startHp, arenaSize: arena.length || ARENA_SIZE };

  return (
    <div className="grid grid-cols-1 items-start gap-3 min-[1180px]:grid-cols-[minmax(0,1fr)_440px] min-[1500px]:grid-cols-[minmax(0,1fr)_520px]">
      <Panel
        title="Biblioteca"
        actions={
          <span className="flex gap-1.5">
            <FilterChip on={tab === 'items'} onClick={() => setTab('items')}>
              Itens · {CATALOG_ITEMS.length}
            </FilterChip>
            <FilterChip on={tab === 'perks'} onClick={() => setTab('perks')}>
              Perks · {PERKS.length}
            </FilterChip>
            <FilterChip on={tab === 'potions'} onClick={() => setTab('potions')}>
              Poções · {CONSUMABLES.length}
            </FilterChip>
          </span>
        }
      >
        {tab === 'items' ? <ItemsTab snapshot={snapshot} pc={pc} /> : tab === 'perks' ? <PerksTab snapshot={snapshot} /> : <PotionsTab snapshot={snapshot} />}
      </Panel>

      <div className="flex min-w-0 flex-col gap-3 min-[1180px]:sticky min-[1180px]:top-0">
        <Panel
          title="Teste no personagem"
          actions={
            <span className="flex items-center gap-1.5">
              {ev.pending && <Chip tone="warn">simulando…</Chip>}
              {pc.changes > 0 && (
                <Button mini onClick={resetPlan}>
                  limpar
                </Button>
              )}
              <Button mini primary onClick={onOpenSimulator}>
                abrir no Simulador
              </Button>
            </span>
          }
        >
          <TestChips snapshot={snapshot} />
          {cur ? (
            <>
              <SurvivalChart cur={cur.survival} next={next?.survival} start={pc.startIndex} total={pc.sector.totalEnemies} here={pc.isCurrentSector ? pc.state.sectorEnemy : undefined} height={140} />
              <StatusTable cur={cur} next={next} scope={scope} compact />
            </>
          ) : (
            <Empty>Simulando…</Empty>
          )}
          <p className="m-0 text-[11px] leading-relaxed text-muted">
            Setor {pc.sector.name}, {fmt(plan.runs)} voltas. O que você testa aqui vai para o mesmo plano do Simulador, onde dá para ver tudo em detalhe.
          </p>
        </Panel>
      </div>
    </div>
  );
}

/** What is being tried right now, each removable. */
function TestChips({ snapshot }: { snapshot: AppSnapshot }) {
  const plan = usePlan();
  const state = snapshot.save!.state;
  const equippedPerks = (state.equippedPerkIds ?? []).filter((id) => id > 0);
  const active = state.activeConsumableIds ?? [];
  const chips: Array<{ key: string; label: string; remove: () => void }> = [];
  for (const [slot, item] of Object.entries(plan.items)) {
    chips.push({
      key: `i-${slot}`,
      label: `${slot}: ${item.itemName}`,
      remove: () =>
        setPlan((p) => {
          const items = { ...p.items };
          delete items[slot];
          return { ...p, items };
        }),
    });
  }
  if (plan.perks) {
    for (const id of plan.perks.filter((x) => !equippedPerks.includes(x))) {
      chips.push({ key: `p-${id}`, label: `perk ${perkInfo(id).name}`, remove: () => setPlan((p) => ({ ...p, perks: null })) });
    }
  }
  if (plan.potions) {
    for (const id of plan.potions.filter((x) => !active.includes(x))) {
      chips.push({ key: `c-${id}`, label: CONSUMABLES.find((c) => c.id === id)?.name ?? `poção ${id}`, remove: () => setPlan((p) => ({ ...p, potions: (p.potions ?? active).filter((x) => x !== id) })) });
    }
  }
  const points = Object.entries(plan.points).filter(([, v]) => v > 0);
  if (points.length) chips.push({ key: 'pts', label: `pontos: ${points.map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(' ')}`, remove: () => setPlan((p) => ({ ...p, points: { atk: 0, def: 0, hp: 0, crit: 0, parry: 0 } })) });
  if (!chips.length) return <div className="text-[12px] text-muted">Nada em teste: escolha um item, perk ou poção à esquerda e clique em testar.</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className="flex items-center gap-1 rounded-full border border-[#4a3512] bg-[#221a0c] py-0.5 pr-0.5 pl-2.5 text-[12px] text-gold">
          {c.label}
          <button type="button" onClick={c.remove} aria-label={`tirar ${c.label} do teste`} className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent text-muted hover:text-ink">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

// ---- items -------------------------------------------------------------------------------------

function ItemsTab({ snapshot, pc }: { snapshot: AppSnapshot; pc: PlanContext }) {
  const plan = usePlan();
  const state = pc.state;
  const [query, setQuery] = useState('');
  const [slot, setSlot] = useState<string>('all');
  const [rarity, setRarity] = useState(-1);
  const [element, setElement] = useState('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('gain');
  const [metric, setMetric] = useState<GearMetric>(plan.metric === 'pvp' ? 'farm' : plan.metric);
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);

  // The whole catalog ranked against the character: rankGear over a bag holding one copy of every
  // item (plus what is equipped, so the slots still resolve).
  // against the plan, like everything else: what a piece is worth depends on what is around it
  const base = pc.planState;
  const catalogState = useMemo(() => {
    const worn = new Set(base.equippedUids);
    return { ...base, inventory: [...base.inventory.filter((i) => worn.has(i.uid)), ...CATALOG_ITEMS.map((c) => catalogAsItem(c))] };
  }, [base]);
  const rankKey = JSON.stringify(['lib', state.level, pc.sector.id, base.equippedUids, pc.plannedPerks, metric, snapshot.combat.weakBothPct]);
  const ranking = useRanking(catalogState, { ...pc.gear, metric, pvpPool: [], bossPool: metric === 'boss' ? pc.gear.bossPool : [] }, rankKey);
  const bestByTemplate = useMemo(() => {
    const out = new Map<number, GearPick>();
    for (const s of ranking.picks) for (const o of s.options) {
      const prev = out.get(o.item.templateId);
      if (!prev || o.score > prev.score) out.set(o.item.templateId, o);
    }
    return out;
  }, [ranking.picks]);

  const owned = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of state.inventory) m.set(i.templateId, (m.get(i.templateId) ?? 0) + 1);
    return m;
  }, [state.inventory]);
  const equippedTemplates = new Set(pc.slots.flatMap((s) => (s.current ? [s.current.templateId] : [])));
  const plannedTemplates = new Set(Object.values(plan.items).map((i) => i.templateId));

  const q = query.trim().toLowerCase();
  const list = CATALOG_ITEMS.filter(
    (c) =>
      (slot === 'all' || c.slot === slot) &&
      (rarity < 0 || RARITIES.indexOf(c.rarity) === rarity) &&
      (element === 'all' || c.element === element) &&
      (!ownedOnly || owned.has(c.id)) &&
      (!q || c.name.toLowerCase().includes(q) || c.effects.some((e) => e.toLowerCase().includes(q))),
  ).sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : sort === 'rarity'
        ? RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || a.name.localeCompare(b.name)
        : (bestByTemplate.get(b.id)?.score ?? -1e9) - (bestByTemplate.get(a.id)?.score ?? -1e9),
  );

  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setLimit(PAGE);
        }}
        placeholder="procurar por nome ou efeito…"
        className="w-full rounded-lg border border-line bg-bg-2 px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip on={slot === 'all'} onClick={() => setSlot('all')}>
          todos
        </FilterChip>
        {ITEM_SLOTS.map((s) => (
          <FilterChip key={s} on={slot === s} onClick={() => setSlot(s)}>
            {s}
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <FilterChip on={ownedOnly} onClick={() => setOwnedOnly(!ownedOnly)}>
          só os que tenho
        </FilterChip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {RARITIES.slice(0, 5).map((r, i) => (
          <FilterChip key={r} on={rarity === i} onClick={() => setRarity(rarity === i ? -1 : i)}>
            <span style={{ color: rarityColor(i) }}>{r}</span>
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        {ELEMENTS.filter((e) => e !== 'Nessuna').map((e) => (
          <FilterChip key={e} on={element === e} onClick={() => setElement(element === e ? 'all' : e)}>
            {e}
          </FilterChip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] tracking-[0.7px] text-muted uppercase">ordenar</span>
        <FilterChip on={sort === 'gain'} onClick={() => setSort('gain')}>
          ganho no personagem
        </FilterChip>
        <FilterChip on={sort === 'rarity'} onClick={() => setSort('rarity')}>
          raridade
        </FilterChip>
        <FilterChip on={sort === 'name'} onClick={() => setSort('name')}>
          nome
        </FilterChip>
        {sort === 'gain' && (
          <>
            <span className="mx-1 h-4 w-px bg-line" />
            {LIB_METRICS.map((m) => (
              <FilterChip key={m.id} on={metric === m.id} onClick={() => setMetric(m.id)}>
                <span title={m.hint}>{m.label}</span>
              </FilterChip>
            ))}
          </>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {ranking.pending ? 'medindo no personagem…' : `${fmt(list.length)} itens`}
        </span>
      </div>

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {list.slice(0, limit).map((c) => (
          <li key={c.id}>
            <ItemRow
              c={c}
              pick={bestByTemplate.get(c.id)}
              metric={metric}
              owned={owned.get(c.id) ?? 0}
              equipped={equippedTemplates.has(c.id)}
              testing={plannedTemplates.has(c.id)}
              open={open === c.id}
              onToggle={() => setOpen(open === c.id ? null : c.id)}
            />
            {open === c.id && <ItemTest c={c} pc={pc} metric={metric} pick={bestByTemplate.get(c.id)} />}
          </li>
        ))}
      </ul>
      {!list.length && <Empty>Nenhum item com esses filtros.</Empty>}
      {list.length > limit && (
        <Button mini className="self-start" onClick={() => setLimit(limit + PAGE * 2)}>
          mostrar mais ({fmt(list.length - limit)})
        </Button>
      )}
    </div>
  );
}

function ItemRow({ c, pick, metric, owned, equipped, testing, open, onToggle }: { c: CatalogItem; pick?: GearPick; metric: GearMetric; owned: number; equipped: boolean; testing: boolean; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        'flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[13px] text-ink',
        testing ? 'border-gold bg-[#2a2113]' : open ? 'border-accent bg-surface-2' : 'border-line bg-surface-2 hover:border-accent',
      )}
    >
      <Icon family="items" id={c.id} title={c.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold" style={{ color: rarityColor(c.rarity) }}>
            {c.name}
          </span>
          <span className="shrink-0 text-[11px] text-muted">{c.slot}</span>
          {c.element !== 'Nessuna' && <Chip tone="info">{c.element}</Chip>}
          {c.isBossExclusive && <Chip tone="warn">boss</Chip>}
          {equipped && <Chip tone="up">equipado</Chip>}
          {!equipped && owned > 0 && <Chip>tenho{owned > 1 ? ` ×${owned}` : ''}</Chip>}
          {testing && <Chip tone="warn">em teste</Chip>}
        </span>
        <span className="num truncate text-[11px] text-muted" title={c.effects.join('\n')}>
          {itemStats(c)}
          {c.effects.length ? ` · ${c.effects.join(' · ')}` : ''}
        </span>
      </span>
      {pick && (
        <span className={cn('num w-[108px] shrink-0 text-right text-[12px] font-semibold', pick.score > 1e-3 ? 'text-up' : pick.score < -1e-3 ? 'text-down' : 'text-muted')} title={`no slot ${pick.slot}`}>
          {pickHeadline(pick, metric)}
        </span>
      )}
    </button>
  );
}

/** The piece next to what the character wears in the slot it would take, and the button to try it. */
function ItemTest({ c, pc, metric, pick }: { c: CatalogItem; pc: PlanContext; metric: GearMetric; pick?: GearPick }) {
  const plan = usePlan();
  const slots = pc.slots.filter((s) => s.slot.startsWith(c.slot) && (!isShield({ itemName: c.name }) || s.slot === 'Arma 2'));
  const [target, setTarget] = useState(pick?.slot ?? slots[0]?.slot ?? '');
  const entry = slots.find((s) => s.slot === target) ?? slots[0];
  if (!entry) return <Empty>Nenhum slot do personagem aceita esta peça.</Empty>;
  const equipped = new Set(pc.state.equippedUids);
  // an owned copy that is not being worn beats a made-up one: it is the real piece
  const mine = pc.state.inventory.find((i) => i.templateId === c.id && !equipped.has(i.uid));
  const piece: SaveItem = mine ?? catalogAsItem(c, pc.slots.indexOf(entry));
  const inTest = plan.items[entry.slot]?.templateId === c.id;
  const same = entry.current?.templateId === c.id;
  return (
    <div className="mt-1 mb-2 flex flex-col gap-2 pl-2">
      {slots.length > 1 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] tracking-[0.7px] text-muted uppercase">testar em</span>
          {slots.map((s) => (
            <FilterChip key={s.slot} on={entry.slot === s.slot} onClick={() => setTarget(s.slot)}>
              {s.slot}
            </FilterChip>
          ))}
        </div>
      )}
      <SwapCard
        slot={entry.slot}
        current={entry.current}
        next={piece}
        pick={pick && pick.slot === entry.slot ? pick : undefined}
        metric={metric}
        mode={inTest ? 'planned' : 'preview'}
        badge={inTest ? 'em teste' : same ? 'a que você usa' : 'na biblioteca'}
        nextLabel={inTest ? 'testando' : 'da biblioteca'}
        applyLabel={inTest ? 'já em teste' : same && !mine ? 'é a que você usa' : 'testar no personagem'}
        onApply={
          inTest || (same && !mine)
            ? undefined
            : () => setPlan((p) => ({ ...p, items: { ...p.items, [entry.slot]: piece } }))
        }
        onUndo={
          inTest
            ? () =>
                setPlan((p) => {
                  const items = { ...p.items };
                  delete items[entry.slot];
                  return { ...p, items };
                })
            : undefined
        }
      />
      {isCatalogItem(piece) && <div className="text-[11px] text-muted">Você não tem esta peça: o teste usa os números do catálogo do jogo, que são os mesmos de qualquer cópia.</div>}
    </div>
  );
}

// ---- perks -------------------------------------------------------------------------------------

function PerksTab({ snapshot }: { snapshot: AppSnapshot }) {
  const plan = usePlan();
  const state = snapshot.save!.state;
  const owned = new Set((state.ownedPerkIds ?? []).filter((id) => id > 0));
  const equipped = (state.equippedPerkIds ?? []).filter((id) => id > 0);
  const planned = plan.perks ?? equipped;
  const tiers = snapshot.combat.perkTiers;
  const [open, setOpen] = useState<number | null>(null);
  const [tier, setTier] = useState(-1);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const maxSlots = Math.max(equipped.length, 3);
  const list = PERKS.map((p) => perkInfo(p.id, tiers))
    .filter((p) => (tier < 0 || p.tier === tier) && (!ownedOnly || owned.has(p.id)))
    .sort((a, b) => b.tier - a.tier || a.name.localeCompare(b.name));
  const setPerks = (ids: number[]) => setPlan((p) => ({ ...p, perks: ids }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {['bronze', 'prata', 'ouro'].map((t, i) => (
          <FilterChip key={t} on={tier === i} onClick={() => setTier(tier === i ? -1 : i)}>
            {t}
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <FilterChip on={ownedOnly} onClick={() => setOwnedOnly(!ownedOnly)}>
          só os que tenho
        </FilterChip>
        <span className="ml-auto text-[11px] text-muted">
          {planned.length} de {maxSlots} slots no teste
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {list.map((p) => {
          const inPlan = planned.includes(p.id);
          const combat = perkModelStatus(p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setOpen(open === p.id ? null : p.id)}
                aria-expanded={open === p.id}
                className={cn(
                  'flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[13px] text-ink',
                  inPlan && !equipped.includes(p.id) ? 'border-gold bg-[#2a2113]' : open === p.id ? 'border-accent bg-surface-2' : 'border-line bg-surface-2 hover:border-accent',
                )}
              >
                <Icon family="perks" id={p.id} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold">{p.name}</span>
                    <PerkBadges id={p.id} tier={p.tier} />
                    {equipped.includes(p.id) ? <Chip tone="up">equipado</Chip> : owned.has(p.id) ? <Chip>tenho</Chip> : <Chip tone="muted">não tenho</Chip>}
                    {inPlan && !equipped.includes(p.id) && <Chip tone="warn">em teste</Chip>}
                  </span>
                  <span className="truncate text-[11px] text-muted">{p.effect}</span>
                </span>
                <Chip tone="accent">{fmt(p.psWeight)} PWR</Chip>
              </button>
              {open === p.id && (
                <div className="mt-1 mb-2 flex flex-col gap-2 rounded-lg border border-line bg-bg-2 p-2.5 text-[12px]">
                  {combat.text && (
                    <div className="text-muted">
                      No combate o jogo aplica: <span className="text-ink">{combat.text}</span>
                    </div>
                  )}
                  {combat.kind === 'partial' && <div className="text-muted">Modelo parcial: {combat.why}</div>}
                  {combat.kind === 'unknown' && <div className="text-down">Perk sem modelo: o teste conta como se ele não fizesse nada.</div>}
                  {inPlan ? (
                    <div className="flex items-center gap-2">
                      <span className="text-muted">{equipped.includes(p.id) && plan.perks === null ? 'Você já usa este perk.' : 'Este perk está no teste.'}</span>
                      <Button mini onClick={() => setPerks(planned.filter((x) => x !== p.id))}>
                        tirar
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] tracking-[0.7px] text-muted uppercase">testar</span>
                      {planned.length < maxSlots && (
                        <Button mini primary onClick={() => setPerks([...planned, p.id])}>
                          no slot livre
                        </Button>
                      )}
                      {planned.map((id, i) => (
                        <Button
                          key={id}
                          mini
                          onClick={() => {
                            const next = [...planned];
                            next[i] = p.id;
                            setPerks(next);
                          }}
                        >
                          no lugar de {perkInfo(id, tiers).name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- potions -----------------------------------------------------------------------------------

function PotionsTab({ snapshot }: { snapshot: AppSnapshot }) {
  const plan = usePlan();
  const state = snapshot.save!.state;
  const active = state.activeConsumableIds ?? [];
  const picked = plan.potions ?? active;
  const ownedCount = new Map((state.ownedConsumableIds ?? []).map((id, i) => [id, state.ownedConsumableCounts?.[i] ?? 0]));
  const toggle = (id: number) => setPlan((p) => ({ ...p, potions: picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id] }));
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {CONSUMABLES.map((c) => {
        const on = picked.includes(c.id);
        const isActive = active.includes(c.id);
        const mods = describeMods(c.mods);
        return (
          <li key={c.id} className={cn('flex min-h-[44px] items-center gap-2.5 rounded-lg border px-2.5 py-1.5', on && !isActive ? 'border-gold bg-[#2a2113]' : 'border-line bg-surface-2')}>
            <Icon family="consumables" id={c.id} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 text-[13px]">
                <span className="font-semibold">{c.name}</span>
                <span className="text-[11px] text-muted">
                  {c.category} · {potionDuration(c.durationSec)}
                </span>
                {isActive && <Chip tone="up">ativa no jogo</Chip>}
                {(ownedCount.get(c.id) ?? 0) > 0 && <Chip>tenho ×{ownedCount.get(c.id)}</Chip>}
                {!affectsCombat(c.mods) && <Chip>fora da luta</Chip>}
              </span>
              <span className="truncate text-[11px] text-muted" title={c.effect}>
                {mods.length ? mods.join(' · ') : c.effect}
              </span>
            </span>
            <Button mini primary={!on} onClick={() => toggle(c.id)} aria-pressed={on}>
              {on ? (isActive ? 'tirar (simular sem)' : 'tirar do teste') : 'testar'}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
