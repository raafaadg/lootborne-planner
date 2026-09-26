/**
 * When the planned potions go down in a lap, and how many doses back to back. A dose lasts 2 h and a
 * tank lap of the Cave takes more than 5: drunk at the start, they are gone before the hard end of the
 * lap. The survival chart shades where they are on.
 */
import type { Consumable } from '@shared/consumables';
import type { PlanOutcome } from '@shared/plan-eval';
import { lapTime } from './build-parts';
import { Button, FilterChip, fmt1 } from './ui';

export function PotionSchedule({
  planned,
  from,
  doses,
  total,
  outcome,
  activeLeft,
  onStep,
  onDoses,
}: {
  /** the potions the plan chose (empty: the plan uses the ones running in the game) */
  planned: Consumable[];
  from: number;
  doses: number;
  total: number;
  outcome: PlanOutcome;
  /** seconds left on the potions running in the game */
  activeLeft: number | null;
  /** move the enemy by `delta` (from the plan's own value, so quick clicks add up) or set the doses */
  onStep: (delta: number) => void;
  onDoses: (doses: number) => void;
}) {
  const timed = planned.filter((c) => c.durationSec > 0);
  const dose = timed.length ? Math.min(...timed.map((c) => c.durationSec)) : 0;
  const ends = outcome.potionWindow ? (outcome.potionEnd === null ? 'duram a volta toda' : `acabam, em média, no inimigo ${fmt1(outcome.potionEnd)}`) : null;
  const lap = outcome.lapSeconds !== null ? `uma volta que fecha leva ~${lapTime(outcome.lapSeconds)}` : 'nenhuma volta fechou na simulação';

  if (!timed.length) {
    if (activeLeft === null) return null;
    return (
      <p className="m-0 text-[11px] leading-relaxed text-muted">
        As poções ativas no jogo ainda duram {lapTime(activeLeft)}; na simulação elas {ends ?? 'duram a volta'} ({lap}).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-[10px] tracking-[0.7px] text-muted uppercase">tomar no inimigo</span>
        <Button mini onClick={() => onStep(-5)} disabled={from <= 0} aria-label="5 inimigos antes">
          −5
        </Button>
        <span className="num w-8 text-center font-semibold text-gold">{from}</span>
        <Button mini onClick={() => onStep(5)} disabled={from >= total - 1} aria-label="5 inimigos depois">
          +5
        </Button>
        <span className="mx-1 h-4 w-px bg-line" />
        <span className="text-[10px] tracking-[0.7px] text-muted uppercase">doses seguidas</span>
        {[1, 2, 3].map((n) => (
          <FilterChip key={n} on={doses === n} onClick={() => onDoses(n)}>
            {n} ({lapTime(n * dose)})
          </FilterChip>
        ))}
      </div>
      <p className="m-0 text-[11px] leading-relaxed text-muted">
        Cada dose dura {lapTime(dose)}; com {doses} {doses === 1 ? 'dose' : 'doses seguidas'} tomadas no inimigo {from}, elas {ends ?? 'duram a volta'} — {lap}. As poções
        rendem mais no fim do setor, onde estão os inimigos difíceis. A faixa azul do gráfico mostra onde estão ativas.
      </p>
    </div>
  );
}
