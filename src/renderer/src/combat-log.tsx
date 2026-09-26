import { useEffect, useRef } from 'react';
import type { SideTally, TurnCounts } from '@shared/contracts';
import { Bar, Chip, cn, fmt, fmt1 } from './ui';

export interface LogTurn extends TurnCounts {
  n: number;
  playerHp: number;
  enemyHp: number;
}

export interface Fighter {
  name: string;
  sub?: string;
  hp: number;
  maxHp: number;
  color?: string;
}

const pct = (a: number, b: number) => (b > 0 ? `${fmt1((a / b) * 100)}%` : '—');

/**
 * What one side did and took. `parries` is how many blows this side *parried*, which is the other
 * side's parried-attack count — the fight reads from each fighter's own point of view.
 */
export function TallyRow({ t, parries, tone }: { t: SideTally; parries: number; tone: 'you' | 'them' }) {
  const color = tone === 'you' ? 'text-gold' : 'text-down';
  return (
    <div className="grid grid-cols-4 gap-1 text-center">
      <Cell label="golpes" value={`${fmt(t.landed)}/${fmt(t.attacks)}`} hint="acertos / ataques" />
      <Cell label="críticos" value={fmt(t.crits)} hint={`${pct(t.crits, t.landed)} dos acertos`} className={t.crits ? color : undefined} />
      <Cell label="aparou" value={fmt(parries)} hint="golpes do outro lado que este lado aparou" />
      <Cell label="dano" value={fmt(t.damage)} hint={`maior golpe ${fmt(t.best)}`} className={color} />
    </div>
  );
}

function Cell({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div title={hint} className="rounded-lg border border-line bg-bg-2 px-1 py-1">
      <div className={cn('num text-[14px] leading-none font-semibold', className ?? 'text-ink')}>{value}</div>
      <div className="mt-0.5 text-[9px] tracking-[0.5px] text-muted uppercase">{label}</div>
    </div>
  );
}

function FighterHead({ f, tone, tally, parries }: { f: Fighter; tone: 'you' | 'them'; tally: SideTally; parries: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={cn('flex min-w-0 items-baseline gap-2', tone === 'them' && 'flex-row-reverse')}>
        <span className="truncate text-sm font-semibold" style={f.color ? { color: f.color } : undefined}>
          {f.name}
        </span>
        {f.sub && <span className="truncate text-[10px] tracking-[0.6px] text-muted uppercase">{f.sub}</span>}
      </div>
      {f.maxHp > 0 ? (
        <Bar
          value={f.hp}
          max={f.maxHp}
          color={tone === 'you' ? 'linear-gradient(90deg,#6b4f12,var(--color-gold))' : 'linear-gradient(90deg,#7a2a22,var(--color-hp))'}
          right={`${fmt(f.hp)} / ${fmt(f.maxHp)}`}
        />
      ) : (
        <div className="text-[11px] text-muted">vida desconhecida (não vimos o começo desta luta)</div>
      )}
      <TallyRow t={tally} parries={parries} tone={tone} />
    </div>
  );
}

/** What a turn did to one side's health bar. */
interface SideTurn {
  /** HP this side lost, whatever caused it */
  lost: number;
  /** this side parried the blow */
  parried: boolean;
  /** the blow that landed on this side was a critical */
  crit: boolean;
  /** HP this side got back */
  heal: number;
  /** HP left afterwards */
  hp: number;
}

/**
 * Splits a turn into the two health ledgers. A counter-attack hurts the side that did *not* swing,
 * so it lands in that side's column: everything about us stays on the left.
 */
function split(t: LogTurn): { you: SideTurn; them: SideTurn } {
  const weSwung = t.playerAttacking;
  return {
    you: {
      lost: weSwung ? t.counterEnemy : t.parried ? 0 : t.damage,
      parried: !weSwung && t.parried,
      crit: !weSwung && t.crit,
      heal: t.healPlayer,
      hp: t.playerHp,
    },
    them: {
      lost: weSwung ? (t.parried ? 0 : t.damage) : t.counterPlayer,
      parried: weSwung && t.parried,
      crit: weSwung && t.crit,
      heal: t.healEnemy,
      hp: t.enemyHp,
    },
  };
}

/**
 * Two ledgers side by side: the left column is only ever about us (our HP, what we lost, what we
 * parried, what we healed) and the right one only about the enemy. The box has a fixed height and
 * follows the newest turn, so it never grows as the fight goes on.
 */
export function CombatLog({
  turns,
  you,
  them,
  youTally,
  themTally,
  height = 320,
  empty,
}: {
  turns: LogTurn[];
  you: Fighter;
  them: Fighter;
  youTally: SideTally;
  themTally: SideTally;
  height?: number;
  empty?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const last = turns.at(-1)?.n ?? 0;
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-3">
        <FighterHead f={you} tone="you" tally={youTally} parries={themTally.parried} />
        <FighterHead f={them} tone="them" tally={themTally} parries={youTally.parried} />
      </div>
      <div ref={box} className="relative overflow-y-auto rounded-[10px] border border-line bg-bg-2" style={{ height }}>
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line" />
        {turns.length ? (
          <ul className="m-0 flex list-none flex-col gap-px p-1">
            {/* the turn number restarts with each fight, so it alone is not unique in this list */}
            {turns.map((t, i) => (
              <TurnRow key={`${t.n}#${i}`} t={t} />
            ))}
          </ul>
        ) : (
          <div className="p-4 text-center text-xs text-muted">{empty ?? 'Nenhum turno ainda.'}</div>
        )}
      </div>
    </div>
  );
}

function TurnRow({ t }: { t: LogTurn }) {
  const { you, them } = split(t);
  return (
    <li className="grid grid-cols-[1fr_26px_1fr] items-center gap-1">
      <Ledger s={you} tone="you" />
      <span className="num text-center text-[10px] text-muted">{t.n}</span>
      <Ledger s={them} tone="them" />
    </li>
  );
}

/** One side's line for this turn. Nothing happened to it -> nothing is drawn. */
function Ledger({ s, tone }: { s: SideTurn; tone: 'you' | 'them' }) {
  const quiet = !s.lost && !s.heal && !s.parried;
  if (quiet) return <span />;
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[12px]',
        tone === 'you' ? 'flex-row-reverse' : '',
        s.parried
          ? 'border-line-2 bg-surface-2'
          : s.lost
            ? tone === 'you'
              ? 'border-[#5a3a34] bg-[#2a1614]'
              : 'border-[#4a3512] bg-[#221a0c]'
            : 'border-transparent',
      )}
    >
      {s.parried && <span className="text-[11px] text-muted">🛡 aparou</span>}
      {s.lost > 0 && <span className={cn('num font-semibold', tone === 'you' ? 'text-down' : 'text-gold')}>−{fmt(s.lost)}</span>}
      {s.crit && <Chip tone="warn">crit</Chip>}
      {s.heal > 0 && <span className="num text-[11px] text-up">+{fmt(s.heal)}</span>}
      <span className="num shrink-0 text-[10px] text-muted" title="vida depois deste turno">
        ❤ {fmt(s.hp)}
      </span>
    </div>
  );
}
