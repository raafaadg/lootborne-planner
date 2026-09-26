/**
 * The pieces the Simulador and the Biblioteca share: an item row, the current → planned comparison,
 * the suggestion row, the perk / point / potion editors, and the three read-outs — the status table,
 * the survival curve and the enemy table. Every read-out takes the equipped build's outcome and,
 * when there is a plan, the plan's, and shows the two side by side.
 */
import { useState, type ReactNode } from 'react';
import { ELEMENTS, RARITIES, type SaveItem } from '@shared/contracts';
import { STAT_KEYS, type StatKey } from '@shared/combat';
import { describeMods, affectsCombat, type Consumable } from '@shared/consumables';
import { BASE_STATS, isShield, type Stats } from '@shared/game-math';
import type { GearMetric, GearPick } from '@shared/gear-advisor';
import { perkModelStatus } from '@shared/perk-mods';
import { isCatalogItem, type PlanOutcome, type Points } from '@shared/plan-eval';
import { CONSUMABLES, PERKS } from './catalog';
import { Icon } from './icons';
import { Button, Chip, Empty, cn, fmt, fmt1, rarityColor } from './ui';

export const STAT_LABEL: Record<StatKey, string> = { atk: 'ATK', def: 'DEF', hp: 'HP', crit: 'CRIT', parry: 'PARRY' };

export const METRICS: Array<{ id: GearMetric; label: string; hint: string }> = [
  { id: 'farm', label: 'Farmar XP', hint: 'XP por hora do ciclo real: luta até morrer, o setor reinicia, repete. Quem morre cedo só farma os inimigos fracos do começo.' },
  { id: 'progress', label: 'Progredir', hint: 'a chance de fechar o setor e até que inimigo a tentativa chega antes de morrer' },
  { id: 'pvp', label: 'Vencer no PvP', hint: 'chance de vitória em lutas simuladas contra os últimos 30 adversários lidos com a ficha exata (atributos e perks)' },
  {
    id: 'boss',
    label: 'Vencer o boss',
    hint: 'chance de vencer o boss de PvP da sua faixa de nível, com a ficha, o equipamento e os efeitos dele, e a resistência e a fraqueza de elemento contra as suas armas',
  },
  { id: 'damage', label: 'Dano', hint: 'dano que você causa por round contra a mistura de inimigos do setor' },
  { id: 'survival', label: 'Sobrevivência', hint: 'vida que sobra depois de uma luta média, já com cura e regeneração' },
  { id: 'power', label: 'PWR', hint: 'o número do jogo, que ignora elemento e procs' },
];

/** 1,45 mi · 66,4 mil · 8.886 */
export function big(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(2).replace('.', ',')} mi`;
  if (a >= 1e4) return `${fmt1(n / 1e3)} mil`;
  return fmt(n);
}

/** 22,7 s · 2min 45s · 8h 04min */
export function secs(s: number): string {
  if (s < 60) return `${fmt1(s)} s`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}min`;
  return `${Math.floor(s / 60)}min ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

const pct = (x: number) => `${fmt1(x * 100)}%`;
const signed = (x: number, f: (v: number) => string = fmt) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${f(Math.abs(x))}`;

export function itemStats(i: Pick<SaveItem, 'hp' | 'atk' | 'def' | 'crit' | 'parry'>): string {
  const parts: string[] = [];
  if (i.hp) parts.push(`${fmt1(i.hp)} PV`);
  if (i.atk) parts.push(`${fmt1(i.atk)} ATK`);
  if (i.def) parts.push(`${fmt1(i.def)} DEF`);
  if (i.crit) parts.push(`${fmt1(i.crit)}% CRIT`);
  if (i.parry) parts.push(`${fmt1(i.parry)}% PAR`);
  return parts.join(' · ');
}

export function elementOf(item: Pick<SaveItem, 'category'>): string | null {
  return item.category > 0 ? (ELEMENTS[item.category] ?? null) : null;
}

function SlotLabel({ children }: { children: ReactNode }) {
  return <span className="w-[62px] shrink-0 text-[10px] tracking-[0.5px] text-muted uppercase">{children}</span>;
}

// ---- items -------------------------------------------------------------------------------------

/** One equipped (or planned) piece, with its stats; the arrow opens the alternatives. */
export function SlotRow({ slot, item, open, onToggle, badge }: { slot: string; item: SaveItem | null; open?: boolean; onToggle?: () => void; badge?: ReactNode }) {
  const el = item ? elementOf(item) : null;
  return (
    <div className={cn('flex min-h-[44px] items-center gap-2.5 rounded-lg border bg-surface-2 px-2.5 py-1.5', open ? 'border-accent' : 'border-line')}>
      <SlotLabel>{slot}</SlotLabel>
      <Icon family="items" id={item?.templateId} title={item?.itemName} />
      {item ? (
        <span className="shrink-0 text-[13px] font-semibold whitespace-nowrap" style={{ color: rarityColor(item.rarity) }}>
          {item.itemName}
        </span>
      ) : (
        <span className="text-[13px] text-muted">vazio</span>
      )}
      {el && <Chip tone="info">{el}</Chip>}
      {badge}
      <span className="num min-w-0 flex-1 truncate text-right text-[11px] text-muted" title={item?.effects.join('\n')}>
        {item ? itemStats(item) : ''}
      </span>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`Trocar ${item?.itemName ?? slot}`}
          className="h-7 w-7 shrink-0 cursor-pointer rounded-md border border-line bg-transparent text-[10px] text-muted hover:border-accent hover:text-ink"
        >
          {open ? '▲' : '▼'}
        </button>
      )}
    </div>
  );
}

/** What the metric on screen says about one swap. */
export function pickHeadline(o: GearPick, metric: GearMetric): string {
  switch (metric) {
    case 'power':
      return `${signed(o.powerDelta)} PWR`;
    case 'survival':
      return `${signed(o.hpPerFightDelta)} PV`;
    case 'progress':
      return `${signed(o.depthDelta, fmt1)} inim.`;
    case 'pvp':
      return `${signed(o.pvpDelta * 100, fmt1)} pp PvP`;
    case 'boss':
      return `${signed(o.pvpDelta * 100, fmt1)} pp boss`;
    case 'damage':
      return `${signed(o.damageDelta * 100, fmt1)}% dano`;
    default:
      return `${signed(o.farmDelta * 100, fmt1)}% XP/h`;
  }
}

/** Everything else a swap does, measured alone against the equipped gear. */
export function pickDetails(o: GearPick, metric: GearMetric): string {
  const parts = [
    metric !== 'farm' && `XP/h ${signed(o.farmDelta * 100, fmt1)}%`,
    metric !== 'progress' && `chega ${signed(o.depthDelta, fmt1)} inimigo${Math.abs(o.depthDelta) >= 1.95 ? 's' : ''}`,
    metric !== 'damage' && `dano ${signed(o.damageDelta * 100, fmt1)}%`,
    metric !== 'survival' && `vida por luta ${signed(o.hpPerFightDelta)}`,
    metric !== 'power' && `PWR ${signed(o.powerDelta)}`,
    // pvpWin is the win chance against whatever is being ranked: the arena, or the boss
    metric !== 'pvp' && metric !== 'boss' && Math.abs(o.pvpDelta) > 0.0005 && `PvP ${signed(o.pvpDelta * 100, fmt1)} pp`,
  ];
  return parts.filter(Boolean).join(' · ');
}

const ITEM_SLOT_NAMES = ['Testa', 'Corpo', 'Cintura', 'Arma', 'Anello', 'Trinket'];

/** Does this piece go in this slot (shields only in Arma 2)? */
export function fitsSlot(slot: string, item: SaveItem): boolean {
  return slot.startsWith(ITEM_SLOT_NAMES[item.slot] ?? '?') && (!isShield(item) || slot === 'Arma 2');
}

/**
 * Every piece of the bag that fits a slot, to put in the plan by hand: no score next to them — what a
 * piece does shows in the status table once it is in the plan, and the optimizer is what ranks.
 */
export function ItemPicker({ slot, current, bag, taken, onPick, onKeep }: { slot: string; current: SaveItem | null; bag: SaveItem[]; taken: Set<number>; onPick: (item: SaveItem) => void; onKeep: () => void }) {
  const seen = new Set<number>(current ? [current.templateId] : []);
  const options = [...bag]
    .sort((a, b) => b.rarity - a.rarity || a.itemName.localeCompare(b.itemName))
    .filter((i) => {
      if (taken.has(i.uid) || !fitsSlot(slot, i) || seen.has(i.templateId)) return false;
      seen.add(i.templateId);
      return true;
    });
  return (
    <ul className="m-0 flex max-h-[300px] list-none flex-col overflow-y-auto rounded-lg border border-line bg-bg-2 p-1">
      <li>
        <button type="button" onClick={onKeep} className="w-full cursor-pointer rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-surface-2">
          ← manter {current?.itemName ?? 'vazio'}
        </button>
      </li>
      {options.map((item) => (
        <li key={item.uid}>
          <button
            type="button"
            onClick={() => onPick(item)}
            title={item.effects.join('\n')}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[12px] text-ink hover:bg-surface-2"
          >
            <Icon family="items" id={item.templateId} />
            <span className="min-w-0 flex-1 truncate font-semibold" style={{ color: rarityColor(item.rarity) }}>
              {item.itemName}
            </span>
            {elementOf(item) && <Chip tone="info">{elementOf(item)}</Chip>}
            <span className="num shrink-0 text-[11px] text-muted">{itemStats(item)}</span>
          </button>
        </li>
      ))}
      {!options.length && <Empty>Nada na bolsa serve aqui.</Empty>}
    </ul>
  );
}

const CELLS: Array<[keyof Stats, string, boolean]> = [
  ['hp', 'PV', false],
  ['atk', 'ATK', false],
  ['def', 'DEF', false],
  ['crit', 'CRIT', true],
  ['parry', 'PARRY', true],
];

function ItemCard({ kicker, kickerClass, item, compare, highlight }: { kicker: string; kickerClass: string; item: SaveItem | null; compare?: SaveItem | null; highlight?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-2 rounded-[10px] border bg-surface p-2.5', highlight ? 'border-gold-deep' : 'border-line')}>
      <div className={cn('text-[10px] font-semibold tracking-[0.8px] uppercase', kickerClass)}>{kicker}</div>
      {item ? (
        <>
          <div className="flex items-center gap-2.5">
            <Icon family="items" id={item.templateId} scale={2} title={item.itemName} />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[14px] font-semibold" style={{ color: rarityColor(item.rarity) }}>
                {item.itemName}
              </span>
              <span className="flex flex-wrap gap-1">
                <Chip>{RARITIES[item.rarity]}</Chip>
                {elementOf(item) && <Chip tone="info">{elementOf(item)}</Chip>}
                {isCatalogItem(item) && <Chip tone="warn" title="saiu da Biblioteca: você ainda não tem esta peça">não está na bolsa</Chip>}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {CELLS.map(([k, label, pctUnit]) => {
              const d = compare !== undefined ? item[k] - (compare?.[k] ?? 0) : 0;
              return (
                <div key={k} className="rounded-md border border-line bg-bg-2 px-0.5 py-1 text-center">
                  <div className="num text-[13px] leading-tight font-semibold">
                    {fmt1(item[k])}
                    {pctUnit ? '%' : ''}
                  </div>
                  <div className="text-[8px] tracking-[0.5px] text-muted">{label}</div>
                  {compare !== undefined && Math.abs(d) > 0.05 && <div className={cn('num text-[10px]', d > 0 ? 'text-up' : 'text-down')}>{signed(d, fmt1)}</div>}
                </div>
              );
            })}
          </div>
          <ul className="m-0 flex flex-col gap-0.5 pl-4 text-[11px] leading-snug text-muted">
            {item.effects.map((e, i) => (
              <li key={`${i}-${e}`}>{e}</li>
            ))}
            {!item.effects.length && <li className="list-none">sem efeitos</li>}
          </ul>
        </>
      ) : (
        <span className="text-[13px] text-muted">vazio</span>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-full border border-line-2 text-gold" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="M13 6l6 6-6 6" />
      </svg>
    </span>
  );
}

/**
 * The equipped piece next to the one the plan (or a suggestion) puts in its place: both stat
 * blocks with the difference under the new one, both effect lists, and what the swap alone does.
 */
export function SwapCard({
  slot,
  current,
  next,
  pick,
  metric,
  mode,
  onUndo,
  onApply,
  onAlternatives,
  onClose,
  applyLabel = 'aplicar no plano',
  badge,
  nextLabel,
}: {
  applyLabel?: string;
  /** the chip and the right-hand card's title, when "troca planejada" / "sugerido" do not fit */
  badge?: string;
  nextLabel?: string;
  slot: string;
  current: SaveItem | null;
  next: SaveItem;
  pick?: GearPick;
  metric: GearMetric;
  mode: 'planned' | 'preview';
  onUndo?: () => void;
  onApply?: () => void;
  onAlternatives?: () => void;
  onClose?: () => void;
}) {
  const planned = mode === 'planned';
  return (
    <div className={cn('flex flex-col gap-2.5 rounded-[10px] border p-3', planned ? 'border-gold bg-[#1f1a12]' : 'border-[#2f4a24] bg-[#131a0f]')}>
      <div className="flex flex-wrap items-center gap-2">
        <SlotLabel>{slot}</SlotLabel>
        <Chip tone={planned ? 'warn' : 'up'}>{badge ?? (planned ? 'troca planejada' : 'sugestão')}</Chip>
        {pick && <span className={cn('num text-[13px] font-semibold', pick.score >= 0 ? 'text-up' : 'text-down')}>{pickHeadline(pick, metric)}</span>}
        <span className="ml-auto flex gap-1.5">
          {onAlternatives && (
            <Button mini onClick={onAlternatives}>
              ver alternativas
            </Button>
          )}
          {onUndo && (
            <Button mini onClick={onUndo}>
              desfazer
            </Button>
          )}
          {onClose && (
            <Button mini onClick={onClose}>
              fechar
            </Button>
          )}
          {onApply && (
            <Button mini primary onClick={onApply}>
              {applyLabel}
            </Button>
          )}
        </span>
      </div>
      <div className="flex items-stretch gap-2.5">
        <ItemCard kicker="atual" kickerClass="text-muted" item={current} />
        <Arrow />
        <ItemCard kicker={nextLabel ?? (planned ? 'planejado' : 'sugerido')} kickerClass={planned ? 'text-gold' : 'text-[#a8dd97]'} item={next} compare={current} highlight />
      </div>
      {pick && (
        <div className="border-t border-row pt-2 text-[12px] text-muted">
          Sozinha, esta troca: <span className="num text-ink">{pickDetails(pick, metric)}</span>
        </div>
      )}
    </div>
  );
}

// ---- perks, points, potions --------------------------------------------------------------------

const TIERS = [
  { label: 'bronze', color: '#b08d57' },
  { label: 'prata', color: '#c0c6cc' },
  { label: 'ouro', color: '#e6b23c' },
];

/** Tier and how well the model knows the perk; unknown perks count as doing nothing. */
export function PerkBadges({ id, tier }: { id: number; tier?: number }) {
  const t = TIERS[tier ?? -1];
  const m = perkModelStatus(id);
  return (
    <>
      {t && (
        <span className="shrink-0 rounded border px-1 text-[9px] tracking-[0.5px] uppercase" style={{ color: t.color, borderColor: t.color }}>
          {t.label}
        </span>
      )}
      {m.kind === 'unknown' && <Chip tone="warn">sem modelo</Chip>}
      {m.kind === 'partial' && (
        <Chip tone="muted" title={m.why}>
          parcial
        </Chip>
      )}
    </>
  );
}

export function perkInfo(id: number, tiers?: Record<number, number>) {
  const p = PERKS.find((x) => x.id === id);
  return p
    ? { ...p, tier: tiers?.[id] ?? p.tier }
    : { id, name: `perk ${id}`, effect: 'perk novo: sem modelo, conta como se não fizesse nada', nameEn: '', effectEn: '', psWeight: 0, tier: tiers?.[id] ?? 0, cost: 0 };
}

/** The perk slots of the plan; each opens the owned perks. */
export function PerkSlots({ planned, equipped, owned, tiers, onChange }: { planned: number[]; equipped: number[]; owned: number[]; tiers?: Record<number, number>; onChange: (ids: number[]) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const slots = Math.max(equipped.length, planned.length, 3);
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: slots }).map((_, i) => {
        const id = planned[i];
        const p = id ? perkInfo(id, tiers) : null;
        const changed = id !== equipped[i];
        return (
          <div key={i} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              aria-expanded={open === i}
              className={cn(
                'flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[13px] text-ink',
                changed ? 'border-gold bg-[#2a2113]' : 'border-line bg-surface-2 hover:border-accent',
              )}
            >
              <SlotLabel>slot {i + 1}</SlotLabel>
              <Icon family="perks" id={id} />
              <span className="shrink-0 font-semibold whitespace-nowrap">{p?.name ?? <span className="text-muted">vazio</span>}</span>
              {id ? <PerkBadges id={id} tier={p?.tier} /> : null}
              {changed && <Chip tone="warn">no plano</Chip>}
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{p?.effect}</span>
              {p && <Chip tone="accent">{fmt(p.psWeight)} PWR</Chip>}
            </button>
            {open === i && (
              <ul className="m-0 flex max-h-[280px] list-none flex-col overflow-y-auto rounded-lg border border-line bg-bg-2 p-1">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...planned];
                      next.splice(i, 1);
                      onChange(next);
                      setOpen(null);
                    }}
                    className="w-full cursor-pointer rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-surface-2"
                  >
                    ← deixar vazio
                  </button>
                </li>
                {owned.map((pid) => {
                  const o = perkInfo(pid, tiers);
                  const taken = planned.includes(pid) && planned[i] !== pid;
                  return (
                    <li key={pid}>
                      <button
                        type="button"
                        disabled={taken}
                        onClick={() => {
                          const next = [...planned];
                          next[i] = pid;
                          onChange(next.filter((x) => x > 0));
                          setOpen(null);
                        }}
                        className={cn('flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[12px] text-ink', taken ? 'cursor-default opacity-40' : 'cursor-pointer hover:bg-surface-2')}
                      >
                        <Icon family="perks" id={pid} />
                        <span className="shrink-0 font-semibold">{o.name}</span>
                        <PerkBadges id={pid} tier={o.tier} />
                        <span className="min-w-0 flex-1 truncate text-muted">{o.effect}</span>
                        <Chip tone="accent">{fmt(o.psWeight)} PWR</Chip>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * "E se eu colocar pontos em…": extra points on top of the allocated ones. With `respec` the points
 * can also come off a stat, down to zero, and the middle number is where the stat ends up.
 */
export function PointSteppers({ points, allocated, respec = false, onChange }: { points: Points; allocated: Points; respec?: boolean; onChange: (p: Points) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {STAT_KEYS.map((k) => {
        const d = points[k];
        const min = respec ? -allocated[k] : 0;
        return (
          <div key={k} className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-0.5 pr-1 pl-3">
            <span className="w-12 text-[12px] font-semibold">{STAT_LABEL[k]}</span>
            <span className="num w-7 text-right text-[11px] text-muted" title="pontos distribuídos no jogo hoje">
              {allocated[k]}
            </span>
            <Button mini onClick={() => onChange({ ...points, [k]: Math.max(min, d - 5) })} disabled={d <= min} aria-label={`menos 5 em ${STAT_LABEL[k]}`}>
              −5
            </Button>
            {respec ? (
              <span
                className={cn('num w-9 text-center text-[13px]', d > 0 ? 'font-semibold text-gold' : d < 0 ? 'font-semibold text-down' : 'text-muted')}
                title={d ? `${d > 0 ? '+' : ''}${d} no respec` : 'sem mudança'}
              >
                {allocated[k] + d}
              </span>
            ) : (
              <span className={cn('num w-7 text-center text-[13px]', d > 0 ? 'font-semibold text-gold' : 'text-muted')}>{d > 0 ? `+${d}` : 0}</span>
            )}
            <Button mini onClick={() => onChange({ ...points, [k]: d + 5 })} aria-label={`mais 5 em ${STAT_LABEL[k]}`}>
              +5
            </Button>
          </div>
        );
      })}
    </div>
  );
}

const CATEGORY_LABEL: Record<Consumable['category'], string> = { Combat: 'Combate', Convenience: 'Conveniência', Pacing: 'Ritmo', Loot: 'Loot', Economy: 'Economia' };

export function potionDuration(sec: number): string {
  if (!sec) return 'instantânea';
  const h = sec / 3600;
  return h >= 1 ? `${fmt1(h)} h` : `${Math.round(sec / 60)} min`;
}

/** Every potion in the game, the running ones marked; toggling one adds it to the plan. */
export function PotionPicker({
  picked,
  active,
  remaining,
  onChange,
  onToggle,
}: {
  picked: number[];
  active: number[];
  remaining: number[];
  onChange: (ids: number[]) => void;
  /** toggle one potion against the latest list (two quick clicks must both count) */
  onToggle?: (id: number) => void;
}) {
  const toggle = (id: number) => (onToggle ? onToggle(id) : onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]));
  const groups = (['Combat', 'Pacing', 'Loot', 'Convenience', 'Economy'] as const)
    .map((c) => ({ category: c, items: CONSUMABLES.filter((x) => x.category === c) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ category, items }) => (
        <div key={category} className="flex flex-col gap-1">
          <div className="text-[10px] tracking-[0.7px] text-muted uppercase">{CATEGORY_LABEL[category]}</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5">
            {items.map((c) => {
              const on = picked.includes(c.id);
              const idx = active.indexOf(c.id);
              const left = idx >= 0 ? remaining[idx] : undefined;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c.id)}
                  title={`${c.effect}\n${describeMods(c.mods).join(' · ')}\n${potionDuration(c.durationSec)}`}
                  className={cn('flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors', on ? 'border-gold bg-[#2a2113]' : 'border-line bg-surface-2 hover:border-accent')}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <Icon family="consumables" id={c.id} />
                    <span className={cn('min-w-0 flex-1 truncate text-[12px] font-semibold', on ? 'text-gold' : 'text-ink')}>{c.name}</span>
                    {idx >= 0 && <Chip tone="up">{left ? potionDuration(left) : 'ativa'}</Chip>}
                    {!affectsCombat(c.mods) && <Chip>fora da luta</Chip>}
                  </div>
                  <div className={cn('truncate text-[11px]', on ? 'text-ink' : 'text-muted')}>{describeMods(c.mods)[0] ?? 'efeito instantâneo'}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- read-outs ---------------------------------------------------------------------------------

type Better = 'more' | 'less' | 'none';

function tone(d: number, better: Better, eps: number): 'up' | 'down' | 'none' {
  if (Math.abs(d) <= eps || better === 'none') return 'none';
  return (d > 0) === (better === 'more') ? 'up' : 'down';
}

function DeltaCell({ text, t }: { text: string; t: 'up' | 'down' | 'none' }) {
  return <span className={cn('num font-semibold', t === 'up' ? 'text-up' : t === 'down' ? 'text-down' : 'text-muted')}>{text}</span>;
}

interface Line {
  label: string;
  sub?: string;
  now: string;
  next: string;
  delta: string;
  t: 'up' | 'down' | 'none';
  highlight?: boolean;
}

function line(label: string, a: number, b: number, f: (v: number) => string, d: { kind: 'rel' | 'abs' | 'pp'; better: Better; eps?: number; f?: (v: number) => string }, sub?: string, highlight?: boolean): Line {
  const diff = d.kind === 'rel' ? (Math.abs(a) > 1e-9 ? (b - a) / Math.abs(a) : 0) : d.kind === 'pp' ? (b - a) * 100 : b - a;
  const eps = d.eps ?? (d.kind === 'rel' ? 0.0005 : d.kind === 'pp' ? 0.05 : 0.05);
  // an infinite side (no lap cleared, never clears) has no difference to show beyond the formatter's own mark
  const endless = !Number.isFinite(diff) && (d.f ?? fmt1)(Math.abs(diff)) === '—';
  const text = Math.abs(diff) <= eps || endless ? '—' : d.kind === 'rel' ? `${signed(diff * 100, fmt1)}%` : d.kind === 'pp' ? `${signed(diff, fmt1)} pp` : signed(diff, d.f ?? fmt1);
  return { label, sub, now: f(a), next: f(b), delta: text, t: tone(diff, d.better, eps), highlight };
}

function origin(o: PlanOutcome, k: keyof Stats): string {
  const b = o.build;
  const parts = [`base ${fmt1(BASE_STATS[k])}`];
  if (Math.abs(b.items[k]) > 0.05) parts.push(`itens ${fmt1(b.items[k])}`);
  if (Math.abs(b.synergy[k]) > 0.05) parts.push(`sinergias ${fmt1(b.synergy[k])}`);
  if (Math.abs(b.allocated[k]) > 0.05) parts.push(`pontos ${fmt1(b.allocated[k])}`);
  if (Math.abs(b.perks[k]) > 0.05) parts.push(`perks ${signed(b.perks[k], fmt1)}`);
  const potion = o.fight[k] - b.stats[k];
  if (Math.abs(potion) > 0.05) parts.push(`poções ${signed(potion, fmt1)}`);
  return parts.join(' · ');
}

export interface StatusScope {
  /** the PvP boss of the level band, for its line */
  bossName?: string;
  bossNote?: string;
  sectorName: string;
  totalEnemies: number;
  runs: number;
  startIndex: number;
  startHp: number | null;
  arenaSize: number;
  /** the Arena's record wave in the save, when the Arena is what is measured */
  arenaRecord?: number;
}

/** The Arena instead of the sector: how far the hours get, how fast, the next boss, the loot. */
function arenaSection(cur: PlanOutcome, n: PlanOutcome, scope: StatusScope, compact?: boolean): { title: string; note?: string; lines: Line[] } {
  const a = cur.arena!;
  const b = n.arena!;
  const h = a.sim.hours;
  const bossWave = a.boss?.wave ?? null;
  const bossIn = (o: NonNullable<PlanOutcome['arena']>) => o.sim.bosses.find((x) => x.wave === bossWave)?.beaten ?? 0;
  const lines: Line[] = [
    line('Recorde esperado', a.sim.record, b.sim.record, (v) => `onda ${fmt1(v)}`, { kind: 'abs', better: 'more' }, `em ${fmt(h)} h de autofight${scope.arenaRecord !== undefined ? ` · hoje: onda ${fmt(scope.arenaRecord)}` : ''}`, true),
    line('Ondas completas, o mais longe', a.sim.best, b.sim.best, fmt1, { kind: 'abs', better: 'more' }, compact ? undefined : 'contando as vitórias da onda em andamento (10 por onda)'),
    line('Vitórias por hora', a.sim.winsPerHour, b.sim.winsPerHour, fmt1, { kind: 'rel', better: 'more' }),
    line('Mortes por hora', a.sim.deathsPerHour, b.sim.deathsPerHour, (v) => fmt1(v), { kind: 'abs', better: 'less' }, compact ? undefined : 'cada morte volta ao múltiplo de 5 abaixo da onda, com a vida cheia'),
    ...(compact ? [] : [line('Duração da luta', a.sim.fightSeconds, b.sim.fightSeconds, secs, { kind: 'abs', better: 'less', eps: 0.5, f: secs }, 'média das lutas jogadas')]),
  ];
  if (a.boss && b.boss) {
    lines.push(
      line(
        `Vencer o boss da onda ${a.boss.wave}`,
        a.boss.win,
        b.boss.win,
        pct,
        { kind: 'pp', better: 'more' },
        compact ? undefined : `${a.boss.name}: ${fmt(a.boss.hp)} PV · ATK ${fmt1(a.boss.atk)} · DEF ${fmt1(a.boss.def)} · resiste ${a.boss.resist}, fraco a ${a.boss.weak}; da vida cheia`,
      ),
      line(`Passar do boss em ${fmt(h)} h`, bossIn(a), bossIn(b), pct, { kind: 'pp', better: 'more' }, compact ? undefined : 'contando o caminho até ele e as mortes'),
    );
  }
  lines.push(
    line('Itens por hora', a.sim.itemsPerHour, b.sim.itemsPerHour, fmt1, { kind: 'rel', better: 'more' }, compact ? undefined : 'das vitórias (15% Viola, 9% Blu, garantido após 9 sem drop)'),
    line('Lendários e míticos por hora', a.sim.rarityPerHour[3]! + a.sim.rarityPerHour[4]!, b.sim.rarityPerHour[3]! + b.sim.rarityPerHour[4]!, (v) => fmt1(v), { kind: 'rel', better: 'more' }),
    line('Dano por round', cur.damagePerRound, n.damagePerRound, fmt1, { kind: 'rel', better: 'more' }, compact ? undefined : `inimigos da onda ${a.wave}`),
    line('Vida por luta', cur.hpPerFight, n.hpPerFight, (v) => signed(v), { kind: 'abs', better: 'more', eps: 0.5, f: fmt }, compact ? undefined : `da vida cheia, com a regeneração da Arena (${a.wave <= 10 ? 4 : 6}%)`),
  );
  if (!compact) {
    lines.push(line('Dano pelo elemento', cur.elementMult, n.elementMult, (v) => `×${v.toFixed(2).replace('.', ',')}`, { kind: 'rel', better: 'more' }, 'na Arena os inimigos não resistem a nada; só as fraquezas contam'));
  }
  return { title: `Arena · onda ${a.wave}`, note: `${fmt(a.sim.runs)} corridas de ${fmt(h)} h`, lines };
}

/** 45 min · 5,6 h */
export function lapTime(s: number): string {
  if (!Number.isFinite(s)) return '—';
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${fmt1(s / 3600)} h`;
}

/** The one table: every number the page has, equipped vs planned. */
export function StatusTable({ cur, next, scope, compact }: { cur: PlanOutcome; next: PlanOutcome | null; scope: StatusScope; compact?: boolean }) {
  const n = next ?? cur;
  // fights won per lap from the Monte Carlo (the same laps as the survival chart): the closed-form run
  // is a ranking proxy and in the long fights of a tank build it can be far off
  const depth = (o: PlanOutcome) => scope.startIndex + o.survival.reduce((a, v) => a + v, 0);
  const sections: Array<{ title: string; note?: string; lines: Line[] }> = [
    {
      title: `Setor · ${scope.sectorName}`,
      note: `${scope.totalEnemies} inimigos · ${fmt(scope.runs)} voltas`,
      lines: [
        line('Chance de fechar o setor', cur.clearProb, n.clearProb, pct, { kind: 'pp', better: 'more' }, scope.startIndex > 0 ? `começando do inimigo ${scope.startIndex} com ${fmt(scope.startHp ?? 0)} PV` : 'começando do inimigo 0 com a vida cheia'),
        ...(compact ? [] : [line('Tentativas até fechar', cur.expectedAttempts ?? Infinity, n.expectedAttempts ?? Infinity, (v) => (Number.isFinite(v) ? fmt1(v) : '∞'), { kind: 'abs', better: 'less' })]),
        ...(compact || (cur.lapSeconds === null && n.lapSeconds === null)
          ? []
          : [line('Duração de uma volta', cur.lapSeconds ?? Infinity, n.lapSeconds ?? Infinity, lapTime, { kind: 'abs', better: 'none', eps: 30, f: lapTime }, 'das voltas que fecham o setor')]),
        ...(compact || (!cur.potionWindow && !n.potionWindow)
          ? []
          : [
              line(
                'Poções acabam no inimigo',
                cur.potionWindow ? (cur.potionEnd ?? scope.totalEnemies) : NaN,
                n.potionWindow ? (n.potionEnd ?? scope.totalEnemies) : NaN,
                (v) => (Number.isNaN(v) ? '—' : v >= scope.totalEnemies ? 'duram a volta' : fmt1(v)),
                { kind: 'abs', better: 'more' },
                'média das voltas que chegam até lá',
              ),
            ]),
        line('Chega até o inimigo', depth(cur), depth(n), fmt1, { kind: 'abs', better: 'more' }, compact ? undefined : 'média das voltas simuladas'),
        line('XP por hora', cur.run.xpPerHour, n.run.xpPerHour, big, { kind: 'rel', better: 'more' }, compact ? undefined : 'o ciclo real: luta até morrer, o setor reinicia', true),
        ...(compact
          ? []
          : [
              line('XP por tentativa', cur.run.xpPerAttempt, n.run.xpPerAttempt, big, { kind: 'rel', better: 'more' }),
              line('Duração da tentativa', cur.run.secondsPerAttempt, n.run.secondsPerAttempt, secs, { kind: 'abs', better: 'none', eps: 0.5, f: secs }),
            ]),
        line('Dano por round', cur.damagePerRound, n.damagePerRound, fmt1, { kind: 'rel', better: 'more' }),
        line('Vida por luta', cur.hpPerFight, n.hpPerFight, (v) => signed(v), { kind: 'abs', better: 'more', eps: 0.5, f: fmt }, compact ? undefined : 'média do setor, já com cura e regeneração'),
      ],
    },
  ];
  if (!compact) {
    const names = (o: PlanOutcome) => o.weapons.join(' + ') || 'sem elemento';
    const sub = names(cur) === names(n) ? `armas ${names(cur)}` : `armas ${names(cur)} → ${names(n)}`;
    sections[0]!.lines.push(line('Dano pelo elemento', cur.elementMult, n.elementMult, (v) => `×${v.toFixed(2).replace('.', ',')}`, { kind: 'rel', better: 'more' }, `${sub}; fraquezas e resistências do setor`));
  }
  if (cur.arena && n.arena) sections[0] = arenaSection(cur, n, scope, compact);
  if (cur.pvp !== null && n.pvp !== null) {
    sections.push({ title: 'PvP', note: `${scope.arenaSize} últimos adversários`, lines: [line('Chance de vitória', cur.pvp, n.pvp, pct, { kind: 'pp', better: 'more' })] });
  }
  if (cur.boss !== null && n.boss !== null && scope.bossName) {
    const lines = [line('Chance de vencer', cur.boss, n.boss, pct, { kind: 'pp', better: 'more' }, compact ? undefined : scope.bossNote)];
    if (!compact && cur.bossElementMult !== null && n.bossElementMult !== null) {
      lines.push(line('Dano das suas armas nele', cur.bossElementMult, n.bossElementMult, (v) => `×${v.toFixed(2).replace('.', ',')}`, { kind: 'rel', better: 'more' }, 'resistência e fraqueza do boss contra o elemento das armas'));
    }
    sections.push({ title: `Boss de PvP · ${scope.bossName}`, note: compact ? undefined : 'lutas simuladas', lines });
  }
  sections.push({
    title: 'Atributos',
    note: compact ? undefined : 'de onde vêm os atuais',
    lines: [
      line('Vida (HP)', cur.fight.hp, n.fight.hp, fmt, { kind: 'abs', better: 'more', f: fmt }, compact ? undefined : origin(cur, 'hp')),
      line('ATK', cur.fight.atk, n.fight.atk, fmt1, { kind: 'abs', better: 'more' }, compact ? undefined : origin(cur, 'atk')),
      line('DEF', cur.fight.def, n.fight.def, fmt1, { kind: 'abs', better: 'more' }, compact ? undefined : origin(cur, 'def')),
      line('CRIT', cur.fight.crit, n.fight.crit, (v) => `${fmt1(v)}%`, { kind: 'abs', better: 'more' }, compact ? undefined : origin(cur, 'crit')),
      line('PARRY', cur.fight.parry, n.fight.parry, (v) => `${fmt1(v)}%`, { kind: 'abs', better: 'more' }, compact ? undefined : origin(cur, 'parry')),
      line('PWR', cur.power, n.power, fmt, { kind: 'abs', better: 'more', eps: 0.5, f: fmt }, compact ? undefined : `fórmula do jogo · ${fmt(cur.build.perkPower)} vêm dos perks`),
    ],
  });

  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-[10px] tracking-[0.6px] text-muted uppercase">
          <th className="w-[44%] border-b border-line py-1.5 pr-2 text-left font-semibold" />
          <th className="border-b border-line px-2 py-1.5 text-right font-semibold">atual</th>
          <th className="border-b border-line px-2 py-1.5 text-right font-semibold text-gold">planejada</th>
          <th className="border-b border-line py-1.5 pl-2 text-right font-semibold">diferença</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((s, si) => [
          <tr key={`s-${s.title}`}>
            <td colSpan={4} className={cn('pt-3 pb-1 text-[10px] font-semibold tracking-[0.7px] text-muted uppercase', si > 0 && 'border-t border-line')}>
              {s.title}
              {s.note && <span className="float-right font-normal tracking-normal normal-case">{s.note}</span>}
            </td>
          </tr>,
          ...s.lines.map((l) => (
            <tr key={`${s.title}-${l.label}`} className={l.highlight ? 'bg-[#1f1a12]' : undefined}>
              <td className="border-t border-row py-1.5 pr-2 align-top">
                <div>{l.label}</div>
                {l.sub && <div className="mt-0.5 text-[11px] leading-snug text-muted">{l.sub}</div>}
              </td>
              <td className={cn('num border-t border-row px-2 py-1.5 text-right align-top', next ? 'text-muted' : 'font-semibold text-ink')}>{l.now}</td>
              <td className={cn('num border-t border-row px-2 py-1.5 text-right align-top font-semibold', !next ? 'text-muted' : l.t !== 'none' ? 'text-gold' : 'text-ink')}>{next ? l.next : '—'}</td>
              <td className="border-t border-row py-1.5 pl-2 text-right align-top">
                <DeltaCell text={next ? l.delta : ''} t={l.t} />
              </td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
  );
}

/** What the plan wins and what it gives up, the headline numbers and the enemies that change most. */
export function PlanSummary({ cur, next }: { cur: PlanOutcome; next: PlanOutcome }) {
  const rows: Array<{ label: string; text: string; good: boolean; weight: number }> = [];
  const add = (label: string, a: number, b: number, f: (v: number) => string, eps: number) => {
    if (Math.abs(b - a) > eps) rows.push({ label, text: `${f(a)} → ${f(b)}`, good: b > a, weight: 10 });
  };
  const rel = (a: number, b: number) => (Math.abs(a) > 1e-9 ? (b - a) / Math.abs(a) : 0);
  const xp = rel(cur.run.xpPerHour, next.run.xpPerHour);
  if (Math.abs(xp) > 0.0005) rows.push({ label: 'XP por hora', text: `${signed(xp * 100, fmt1)}%`, good: xp > 0, weight: 20 });
  add('Chance de fechar', cur.clearProb, next.clearProb, pct, 0.0005);
  // from the Monte Carlo, like the chart (the closed-form run is a proxy, and far off in long fights)
  const won = (o: PlanOutcome) => o.survival.reduce((x, v) => x + v, 0);
  if (cur.arena && next.arena) {
    const a = cur.arena;
    const b = next.arena;
    rows.push(...(Math.abs(b.sim.record - a.sim.record) > 0.05 ? [{ label: 'Recorde esperado', text: `onda ${fmt1(a.sim.record)} → ${fmt1(b.sim.record)}`, good: b.sim.record > a.sim.record, weight: 20 }] : []));
    const deaths = b.sim.deathsPerHour - a.sim.deathsPerHour;
    if (Math.abs(deaths) > 0.05) rows.push({ label: 'Mortes por hora', text: `${fmt1(a.sim.deathsPerHour)} → ${fmt1(b.sim.deathsPerHour)}`, good: deaths < 0, weight: 10 });
    add('Vitórias por hora', a.sim.winsPerHour, b.sim.winsPerHour, fmt1, 0.05);
    if (a.boss && b.boss) add(`Boss da onda ${a.boss.wave}`, a.boss.win, b.boss.win, pct, 0.0005);
  } else add('Lutas vencidas por volta', won(cur), won(next), fmt1, 0.05);
  const dmg = rel(cur.damagePerRound, next.damagePerRound);
  if (Math.abs(dmg) > 0.0005) rows.push({ label: 'Dano por round', text: `${signed(dmg * 100, fmt1)}%`, good: dmg > 0, weight: 10 });
  add('Vida por luta', cur.hpPerFight, next.hpPerFight, (v) => signed(v), 0.5);
  if (cur.pvp !== null && next.pvp !== null) add('Vitória no PvP', cur.pvp, next.pvp, pct, 0.0005);
  if (cur.boss !== null && next.boss !== null) add('Vitória contra o boss', cur.boss, next.boss, pct, 0.0005);
  add('PWR', cur.power, next.power, fmt, 0.5);
  const enemies = cur.odds
    .map((o, i) => ({ o, d: (next.odds[i]?.win ?? o.win) - o.win, b: next.odds[i]?.win ?? o.win }))
    .filter((x) => Math.abs(x.d) >= 0.05)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  for (const e of enemies.filter((x) => x.d > 0).slice(0, 3)) rows.push({ label: `${e.o.name} ${e.o.color}`, text: `${pct(e.o.win)} → ${pct(e.b)}`, good: true, weight: 1 });
  for (const e of enemies.filter((x) => x.d < 0).slice(0, 3)) rows.push({ label: `${e.o.name} ${e.o.color}`, text: `${pct(e.o.win)} → ${pct(e.b)}`, good: false, weight: 1 });
  const gains = rows.filter((r) => r.good).sort((a, b) => b.weight - a.weight);
  const losses = rows.filter((r) => !r.good).sort((a, b) => b.weight - a.weight);
  const col = (title: string, cls: string, list: typeof rows) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className={cn('text-[10px] font-semibold tracking-[0.8px] uppercase', cls)}>{title}</div>
      {list.length ? (
        <ul className="m-0 list-none p-0 text-[12px]">
          {list.map((r) => (
            <li key={r.label} className="flex justify-between gap-2.5 border-t border-row py-1">
              <span className="text-muted">{r.label}</span>
              <span className="num whitespace-nowrap text-ink">{r.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-[12px] text-muted">nada</span>
      )}
    </div>
  );
  return (
    <div className="flex gap-4">
      {col('O plano ganha', 'text-up', gains)}
      {col('O plano perde', 'text-down', losses)}
    </div>
  );
}

/** P(still alive) enemy by enemy, the equipped build dashed and the plan in gold. */
export function SurvivalChart({
  cur,
  next,
  start,
  total,
  here,
  height = 160,
  windows = [],
  caption = 'chance de ainda estar vivo, inimigo a inimigo',
  unit = 'inimigos',
  endLabel = 'fim do setor',
  endValue = (s: number[]) => pct(s[s.length - 1] ?? 0),
}: {
  cur: number[];
  next?: number[] | null;
  start: number;
  total: number;
  here?: number;
  height?: number;
  /** the Arena draws waves instead of enemies */
  caption?: string;
  unit?: string;
  endLabel?: string;
  endValue?: (s: number[]) => string;
  /** where potions are on in the lap: from the enemy they go down at to the one they run out at (null: to the end) */
  windows?: Array<{ from: number; to: number | null; planned: boolean }>;
}) {
  const w = 600;
  const h = height;
  const lastAlive = (s: number[]) => {
    let i = s.length - 1;
    while (i > 0 && s[i]! < 0.005) i--;
    return i;
  };
  const span = Math.min(total - start, Math.max(10, Math.max(lastAlive(cur), next ? lastAlive(next) : 0) + 4));
  const end = start + span;
  const x = (idx: number) => ((idx - start) / span) * w;
  const y = (p: number) => 6 + (1 - p) * (h - 12);
  const pts = (s: number[]) => [`${x(start)},${y(1)}`, ...s.slice(0, span).map((p, i) => `${x(start + i + 1)},${y(p)}`)].join(' ');
  const step = Math.max(1, Math.ceil(span / 6));
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => start + i * step);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[10px] tracking-[0.7px] text-muted uppercase">
        <span>{caption}</span>
        <span>
          {unit} {start} → {end} de {total}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full rounded-[10px] border border-line bg-bg-2" style={{ height }} role="img" aria-label="Curva de sobrevivência">
        {windows.map((win, k) => {
          const a = Math.max(start, Math.min(end, win.from));
          const b = Math.max(a, Math.min(end, win.to ?? end));
          if (b <= a) return null;
          return (
            <rect
              key={k}
              x={x(a)}
              width={x(b) - x(a)}
              y={win.planned ? 0 : h / 2}
              height={win.planned ? h : h / 2}
              fill={win.planned ? 'color-mix(in oklab, var(--color-xp) 16%, transparent)' : 'color-mix(in oklab, var(--color-ink) 8%, transparent)'}
            />
          );
        })}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={w} y1={y(g)} y2={y(g)} stroke="var(--color-line)" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
        ))}
        {next && <polygon points={`${x(start)},${h} ${pts(next)} ${x(end)},${h}`} fill="color-mix(in oklab, var(--color-gold) 14%, transparent)" />}
        {!next && <polygon points={`${x(start)},${h} ${pts(cur)} ${x(end)},${h}`} fill="color-mix(in oklab, var(--color-gold) 14%, transparent)" />}
        <polyline points={pts(cur)} fill="none" stroke={next ? 'var(--color-ink)' : 'var(--color-gold)'} strokeOpacity={next ? 0.55 : 1} strokeWidth="2" strokeDasharray={next ? '5 4' : undefined} vectorEffect="non-scaling-stroke" />
        {next && <polyline points={pts(next)} fill="none" stroke="var(--color-gold)" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />}
        {here !== undefined && here >= start && here <= end && <line x1={x(here)} x2={x(here)} y1="0" y2={h} stroke="var(--color-xp)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="num relative h-3.5 text-[10px] text-muted">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${((t - start) / span) * 100}%` }}>
            {t}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        {next ? (
          <>
            <span className="flex items-center gap-1.5">
              <svg width="20" height="6" aria-hidden="true">
                <line x1="0" x2="20" y1="3" y2="3" stroke="var(--color-ink)" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="5 4" />
              </svg>
              atual · {endLabel} {endValue(cur)}
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="20" height="6" aria-hidden="true">
                <line x1="0" x2="20" y1="3" y2="3" stroke="var(--color-gold)" strokeWidth="2.4" />
              </svg>
              planejada · {endLabel} {endValue(next)}
            </span>
          </>
        ) : (
          <span>
            {endLabel}: {endValue(cur)}
          </span>
        )}
        {here !== undefined && <span className="text-xp">│ você está no inimigo {here}</span>}
        {windows.some((w2) => w2.planned) && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: 'color-mix(in oklab, var(--color-xp) 30%, transparent)' }} />
            poções do plano ativas
          </span>
        )}
        {windows.some((w2) => !w2.planned) && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: 'color-mix(in oklab, var(--color-ink) 16%, transparent)' }} />
            poções atuais ativas
          </span>
        )}
      </div>
    </div>
  );
}

const ENEMY_COLOR = { Grigio: 'var(--color-enemy-0)', Blu: 'var(--color-enemy-1)', Viola: 'var(--color-enemy-2)' } as const;
const winClass = (p: number) => (p >= 0.999 ? 'text-up' : p >= 0.9 ? 'text-gold' : 'text-down');

/** The sector's enemies, with the win chance of the equipped build and of the plan. */
export function EnemyTable({ cur, next }: { cur: PlanOutcome; next: PlanOutcome | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="tabela text-[13px]">
        <thead>
          <tr>
            <th>Inimigo</th>
            <th>Nv</th>
            <th title="HP · ATK · DEF · CRIT · PARRY">Ficha</th>
            <th title={cur.arena ? 'a onda' : 'posições do setor em que aparece'}>Aparece</th>
            <th title={cur.arena ? 'vezes, em média, nas 10 lutas da onda' : 'vezes, em média, numa volta'}>Vezes</th>
            <th className="esq" title="O elemento só conta nas ARMAS: cada arma do elemento que ele resiste tira 15% do seu dano, cada uma do elemento fraco soma 15% (as duas: +40%). Elmo, armadura, anel e amuleto não sofrem resistência; o elemento deles só vale para as sinergias.">
              Suas armas contra ele
            </th>
            <th>Vitória {next ? 'atual' : ''}</th>
            {next && <th className="text-gold">Planejada</th>}
            {next && <th>Diferença</th>}
            <th title="vida ganha ou perdida por luta, já com cura e regeneração">Vida por luta</th>
            {next && <th className="text-gold">Planejada</th>}
            <th>Turnos</th>
            <th title="DEF em que essa luta deixa de custar vida">DEF equilíbrio</th>
          </tr>
        </thead>
        <tbody>
          {cur.odds.map((o, i) => {
            const n = next?.odds[i];
            const d = n ? n.win - o.win : 0;
            return (
              <tr key={`${o.name}-${o.color}`}>
                <td>
                  <span className="font-semibold" style={{ color: ENEMY_COLOR[o.color] }}>
                    {o.name}
                  </span>{' '}
                  <span className="text-[11px] text-muted">{o.color}</span>
                </td>
                <td>{o.level}</td>
                <td className="text-[11px] text-muted">
                  {fmt(o.hp)} · {fmt1(o.atk)} · {fmt1(o.def)} · {fmt1(o.crit)} · {fmt1(o.parry)}
                </td>
                <td className="text-muted">{cur.arena ? `onda ${o.first}` : `${o.first}–${o.last}`}</td>
                <td>{fmt1(o.appear)}</td>
                <td className="esq text-[11px]">
                  {o.resist !== 'Nessuna' && <span className="text-down">arma {o.resist}{o.resist2 && o.resist2 !== 'Nessuna' ? ` ou ${o.resist2}` : ''}: −15%</span>}
                  {o.resist !== 'Nessuna' && o.weak !== 'Nessuna' && <span className="text-muted"> · </span>}
                  {o.weak !== 'Nessuna' && <span className="text-up">arma {o.weak}: +15%</span>}
                  {o.resist === 'Nessuna' && o.weak === 'Nessuna' && <span className="text-muted">—</span>}
                </td>
                <td className={cn('font-semibold', winClass(o.win))}>{pct(o.win)}</td>
                {n && <td className={cn('font-semibold', winClass(n.win))}>{pct(n.win)}</td>}
                {n && <td className={cn('font-semibold', Math.abs(d) < 0.0005 ? 'text-muted' : d > 0 ? 'text-up' : 'text-down')}>{Math.abs(d) < 0.0005 ? '—' : `${signed(d * 100, fmt1)} pp`}</td>}
                <td className={o.hpDelta < 0 ? 'text-down' : 'text-up'}>{signed(o.hpDelta)}</td>
                {n && <td className={n.hpDelta < 0 ? 'text-down' : 'text-up'}>{signed(n.hpDelta)}</td>}
                <td className="text-muted">{n ? `${fmt(o.turns)} → ${fmt(n.turns)}` : fmt(o.turns)}</td>
                <td className={o.sustains ? 'text-muted' : 'font-semibold text-gold'}>{o.sustains ? 'já sustenta' : o.breakEvenDef === null ? '—' : fmt1(o.breakEvenDef)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
