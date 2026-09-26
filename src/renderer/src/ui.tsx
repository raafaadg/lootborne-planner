import { useState } from 'react';
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { RARITIES, type Rarity } from '@shared/contracts';

// Components in the BotFarm Planner panel grammar (card, kpi, grupo, pilula, tag, chip, chave).

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

export const fmt = (n: number | undefined | null) => (n === undefined || n === null || Number.isNaN(n) ? '—' : nf.format(n));
export const fmt1 = (n: number | undefined | null) => (n === undefined || n === null || Number.isNaN(n) ? '—' : nf1.format(n));

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function rarityColor(r: Rarity | number): string {
  const idx = typeof r === 'number' ? r : RARITIES.indexOf(r);
  return `var(--color-rar-${Math.max(0, idx)})`;
}

/** `.card`: 12 px panel with the small uppercase dim title. */
export function Panel({
  title,
  actions,
  className,
  collapsible,
  defaultCollapsed,
  summary,
  children,
}: PropsWithChildren<{
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** click the title to fold the panel away */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** shown next to the title while folded, so the state stays readable */
  summary?: ReactNode;
}>) {
  const [collapsed, setCollapsed] = useState(Boolean(defaultCollapsed));
  const folded = Boolean(collapsible && collapsed);
  return (
    <section className={cn('flex min-w-0 flex-col gap-2.5 rounded-card border border-line bg-surface px-3.5 py-3', className)}>
      {title !== undefined && (
        <h2 className="m-0 flex min-w-0 items-center gap-2 text-[11px] font-semibold tracking-[0.8px] text-muted uppercase">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!folded}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[11px] font-semibold tracking-[0.8px] text-muted uppercase hover:text-ink"
            >
              <span className={cn('inline-block text-[9px] transition-transform', folded ? '' : 'rotate-90')}>▶</span>
              {title}
              {folded && summary && <span className="min-w-0 truncate normal-case tracking-normal">{summary}</span>}
            </button>
          ) : (
            title
          )}
          {actions && <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal">{actions}</span>}
        </h2>
      )}
      {!folded && children}
    </section>
  );
}

/** `.grupo`: a section label followed by a thin rule (e.g. "MEDIDO × PROJETADO"). */
export function Grupo({ children, nota }: PropsWithChildren<{ nota?: ReactNode }>) {
  return (
    <div className="mt-1 mb-0.5 flex items-center gap-2.5">
      <span className="text-[10px] tracking-[0.8px] whitespace-nowrap text-muted uppercase">{children}</span>
      <span className="h-px flex-1 bg-line" />
      {nota && <span className="text-[11px] whitespace-nowrap text-muted">{nota}</span>}
    </div>
  );
}

export function IconBox({ children, size = 'md' }: PropsWithChildren<{ size?: 'sm' | 'md' }>) {
  return (
    <span
      className={cn(
        'flex flex-none items-center justify-center border border-line bg-bg-2',
        size === 'md' ? 'h-9 w-9 rounded-[10px] text-[17px]' : 'h-[26px] w-[26px] rounded-lg text-[13px]',
      )}
    >
      {children}
    </span>
  );
}

/** `.kpi`: icon square + value + uppercase label + optional sub line. */
export function Kpi({ icon, value, label, sub, tone, title }: { icon: ReactNode; value: ReactNode; label: ReactNode; sub?: ReactNode; tone?: 'gold' | 'xp' | 'alerta' | 'good'; title?: string }) {
  return (
    <div title={title} className={cn('flex min-w-0 items-start gap-2.5 rounded-card border bg-surface px-3 py-2.5', tone === 'alerta' ? 'border-[#5a3a34]' : 'border-line')}>
      <IconBox>{icon}</IconBox>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'num truncate text-[19px] leading-tight font-semibold',
            tone === 'gold' && 'text-gold',
            tone === 'xp' && 'text-xp',
            tone === 'alerta' && 'text-down',
            tone === 'good' && 'text-up',
          )}
        >
          {value}
        </div>
        <div className="mt-0.5 text-[10px] leading-tight tracking-[0.7px] text-muted uppercase">{label}</div>
        {sub !== undefined && <div className={cn('mt-0.5 text-[11px] leading-snug text-muted', typeof sub === 'string' && 'line-clamp-2')}>{sub}</div>}
      </div>
    </div>
  );
}

/** Small boxed figure (the "OURO/H · 60 S  337.580.014" boxes). */
export function Stat({ label, value, hint, tone, destaque }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'up' | 'down' | 'accent' | 'xp'; destaque?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 rounded-[10px] border bg-surface px-3 py-2', destaque ? 'border-gold' : 'border-line')}>
      <span className="text-[10px] tracking-[0.7px] text-muted uppercase">{label}</span>
      <span className={cn('num text-[17px] leading-tight font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'accent' && 'text-gold', tone === 'xp' && 'text-xp', !tone && 'text-ink')}>
        {value}
      </span>
      {hint !== undefined && <span className="truncate text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

/** `.barra`: 6 px track, gold gradient by default. */
export function Bar({ value, max, color, label, right, thick }: { value: number; max: number; color?: string; label?: ReactNode; right?: ReactNode; thick?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1">
      {(label !== undefined || right !== undefined) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted">{label}</span>
          <span className="num text-ink">{right}</span>
        </div>
      )}
      <div className={cn('w-full overflow-hidden rounded bg-bg-2', thick ? 'h-2' : 'h-1.5')}>
        <i
          className="block h-full rounded transition-[width] duration-300"
          style={{ width: `${pct}%`, background: color ?? 'linear-gradient(90deg, var(--color-gold-deep), var(--color-gold))' }}
        />
      </div>
    </div>
  );
}

type Tone = 'muted' | 'up' | 'down' | 'warn' | 'accent' | 'info';
const TAG_TONES: Record<Tone, string> = {
  muted: 'border-line-2 text-muted',
  up: 'border-[#2f4a24] bg-[#16220f] text-[#a8dd97]',
  down: 'border-[#5a3a34] bg-[#2a1614] text-[#f0a79c]',
  warn: 'border-[#5a4a24] bg-[#2a2113] text-gold',
  accent: 'border-[#4a3512] bg-[#221a0c] text-gold',
  info: 'border-[#244552] bg-[#10202a] text-xp',
};

/** `.tag`: small rounded label. */
export function Chip({ children, tone = 'muted', title }: PropsWithChildren<{ tone?: Tone; title?: string }>) {
  return (
    <span title={title} className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[10px] font-semibold whitespace-nowrap', TAG_TONES[tone])}>
      {children}
    </span>
  );
}

/** `.pilula`: status pill with the pulsing dot. */
export function Pill({ children, state = 'off', pulse, title }: PropsWithChildren<{ state?: 'on' | 'off' | 'alerta' | 'ruim'; pulse?: boolean; title?: string }>) {
  const styles = {
    on: 'border-[#2f4a24] bg-[#16220f] text-[#a8dd97]',
    off: 'border-line bg-surface-2 text-muted',
    alerta: 'border-[#5a4a24] bg-[#2a2113] text-gold',
    ruim: 'border-[#5a3a34] bg-[#2a1614] text-[#f0a79c]',
  } as const;
  return (
    <span title={title} className={cn('inline-flex items-center gap-[7px] rounded-full border px-3 py-1 text-[11px] font-semibold tracking-[0.6px] whitespace-nowrap uppercase', styles[state])}>
      <span className={cn('h-[7px] w-[7px] rounded-full bg-current', pulse && 'animate-pulsa')} />
      {children}
    </span>
  );
}

/** `.chip`: rounded filter toggle; `on` is gold with a check. */
export function FilterChip({ on, onClick, children }: PropsWithChildren<{ on: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-full border px-3 py-1 text-xs whitespace-nowrap text-ink transition-colors select-none',
        on ? 'border-gold bg-[#3a2c10] shadow-[inset_0_0_0_1px_var(--color-gold)]' : 'border-line bg-surface-2 hover:border-accent',
      )}
    >
      {on && <span className="opacity-80">✓ </span>}
      {children}
    </button>
  );
}

export function Button({ primary, mini, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; mini?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'cursor-pointer border transition-colors disabled:cursor-default disabled:opacity-40',
        mini ? 'rounded-md px-2.5 py-0.5 text-xs' : 'rounded-lg px-3 py-1.5 text-sm',
        primary
          ? 'border-accent bg-accent font-semibold text-accent-ink hover:border-gold hover:bg-gold'
          : 'border-line bg-surface-2 text-ink hover:border-accent hover:text-white',
        className,
      )}
    />
  );
}

/** Delta badge (the red/green "-52%" pills). */
export function Delta({ value, suffix = '' }: { value: number; suffix?: string }) {
  const good = value >= 0;
  return (
    <span className={cn('num rounded-full border px-2.5 py-0.5 text-xs font-semibold', good ? 'border-[#2f4a24] bg-[#16220f] text-up' : 'border-[#5a3a34] bg-[#2a1614] text-down')}>
      {good ? '+' : ''}
      {fmt(value)}
      {suffix}
    </span>
  );
}

export function RarityName({ rarity, children }: PropsWithChildren<{ rarity: Rarity | number }>) {
  return (
    <span className="font-semibold" style={{ color: rarityColor(rarity) }}>
      {children}
    </span>
  );
}

export function Empty({ children }: PropsWithChildren) {
  return <div className="py-6 text-center text-[13px] text-muted">{children}</div>;
}

/** `.chave` + `.botao-chave`: labelled switch with the gold knob. */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-row py-1.5 last:border-b-0">
      <span className="flex flex-1 flex-col">
        <span className="text-[13px]">{label}</span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative h-[22px] w-10 flex-none cursor-pointer rounded-xl border transition-colors', checked ? 'border-accent bg-[#4a3512]' : 'border-line-2 bg-bg-2')}
      >
        <span className={cn('absolute top-[2px] h-4 w-4 rounded-full transition-[left]', checked ? 'left-5 bg-gold' : 'left-[2px] bg-muted')} />
      </button>
    </div>
  );
}
