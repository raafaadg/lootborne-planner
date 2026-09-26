/**
 * "Rumo ao nível 60": the XP left to the cap and how long the current farm takes to bank it, level by
 * level. The figures come from level-eta.ts: the last hour of fights re-priced at each level ahead,
 * because the farm pays less every level (the over-level penalty) while PvP pays more.
 */
import { sectorIntendedLevel } from '@shared/combat';
import type { LevelEta } from '@shared/level-eta';
import { sectorPayAt } from '@shared/level-eta';
import { big } from './build-parts';
import { sector as sectorData } from './catalog';
import { cn, fmt, fmt1 } from './ui';

/** 0,3 h → 18 min · 26,7 h · 130 h (5,4 dias) */
export function hours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${fmt1(h)} h`;
  return `${fmt(Math.round(h))} h (${fmt1(h / 24)} dias)`;
}

const pct = (x: number) => `${fmt(Math.round(x * 100))}%`;

export function LevelGoal({ eta, sectorsCleared }: { eta: LevelEta; sectorsCleared: boolean[] }) {
  const { steps, target } = eta;
  const rated = eta.perHour !== null;
  const sec = eta.sector;
  const fades = sec !== null && eta.pveShare > 0.2 && steps.length > 1 && sectorPayAt(sec, steps.at(-1)!.level) < sectorPayAt(sec, eta.level);
  const next = sec !== null ? sectorData(sec + 1) : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-line-2 bg-bg-2 text-[15px]">🏁</span>
          <div className="flex flex-col">
            <span className="text-[11px] tracking-[0.8px] text-muted uppercase">nível {target} no farm atual</span>
            <span className="num text-[22px] leading-tight font-semibold text-xp">
              {eta.hours !== null ? `~${hours(eta.hours)}` : rated ? 'não chega' : '—'}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-0.5 text-[12px]">
          <span className="num text-ink">
            faltam <b>{big(eta.xpLeft)} XP</b> em {steps.length} {steps.length === 1 ? 'nível' : 'níveis'}
          </span>
          {rated ? (
            <span className="num text-muted">
              no ritmo de agora ({big(eta.perHour!)} XP/h) seriam {hours(eta.flatHours!)}: {eta.hours === null || eta.hours > eta.flatHours! * 1.1 ? 'mas o XP por luta cai a cada nível' : 'o ritmo se mantém'}
            </span>
          ) : (
            <span className="text-muted">o tempo aparece depois de 10 min de lutas</span>
          )}
        </div>
        <span className="ml-auto text-[11px] text-muted">
          {rated ? `${fmt(eta.fights)} lutas dos últimos ${fmt(Math.round(eta.spanMs / 60_000))} min, repagas em cada nível` : ''}
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-1.5">
        {steps.map((s) => {
          const rate = s.pvePerHour + s.pvpPerHour;
          return (
            <div key={s.level} className="flex flex-col gap-1 rounded-lg border border-line bg-bg-2 px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="num text-[12px] font-semibold text-ink">
                  {s.level} → {s.level + 1}
                </span>
                <span className={cn('num text-[13px] font-semibold', s.hours === null ? 'text-down' : 'text-xp')}>{s.hours !== null ? hours(s.hours) : rated ? '∞' : '—'}</span>
              </div>
              <div className="num text-[11px] text-muted">
                {big(s.xpLeft)} XP{rated ? ` · ${big(rate)} XP/h` : ''}
              </div>
              {rated && (
                <>
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2" title={`PvE ${big(s.pvePerHour)} · PvP ${big(s.pvpPerHour)} XP/h`}>
                    <span className="h-full bg-xp" style={{ width: `${rate ? (s.pvePerHour / rate) * 100 : 0}%` }} />
                    <span className="h-full bg-gold" style={{ width: `${rate ? (s.pvpPerHour / rate) * 100 : 0}%` }} />
                  </div>
                  <div className="num text-[10px] text-muted">
                    PvE {big(s.pvePerHour)}
                    {sec !== null && ` (${pct(sectorPayAt(sec, s.level))})`} · PvP {big(s.pvpPerHour)}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {fades && sec !== null && (
        <p className="m-0 text-[11px] leading-relaxed text-muted">
          <b className="text-ink">Por que demora:</b> no {sectorData(sec)?.name ?? `setor ${sec}`} o jogo mede o XP a partir do nível {sectorIntendedLevel(sec)} (ou do
          inimigo, se for maior). Três níveis acima disso o PvE perde 12 pontos por nível: os inimigos daqui pagam{' '}
          {steps.map((s) => pct(sectorPayAt(sec, s.level))).join(' → ')} nos níveis {steps[0]!.level}–{steps.at(-1)!.level}, e o PvP (que sobe com o seu nível) vira quase
          todo o XP.
          {next && (
            <>
              {' '}
              O {next.name} (setor {sec + 1}, nível {sectorIntendedLevel(sec + 1)}) paga {pct(sectorPayAt(sec + 1, steps.at(-1)!.level))} no {steps.at(-1)!.level}
              {sectorsCleared[sec] ? ': ele já está liberado.' : `, e abre quando você limpa o setor ${sec}.`}
            </>
          )}
        </p>
      )}
    </div>
  );
}
