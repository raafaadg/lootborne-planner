import { PVP_BOSSES, bossForecast } from '@shared/battles';
import type { SaveState } from '@shared/contracts';
import { Kpi, cn } from './ui';

/**
 * How many ranked PvP matches are left before the PvP boss of your level band shows up, straight
 * from the save's BossPvpEncounter counter (bossForecast). `interval` is the loop's PvP rhythm, for
 * the time estimate; without it the card shows the count alone.
 */
export function NextBossKpi({ state, interval }: { state: SaveState | null | undefined; interval: number | null }) {
  const forecast = bossForecast(state);
  if (!forecast) return <Kpi icon="👑" value="—" label="PvP até o boss" sub="o save ainda não disse" />;
  const { boss, defeated, rankedBefore, counter, threshold } = forecast;
  if (!boss) return <Kpi icon="👑" value="—" label="PvP até o boss" sub={`o primeiro boss aparece no nível ${PVP_BOSSES[0]!.level}`} />;
  if (defeated || rankedBefore === null) {
    const next = PVP_BOSSES[boss.index + 1];
    return <Kpi icon="👑" value="nenhum" label="PvP até o boss" sub={`${boss.name} já foi derrotado${next ? `; ${next.name} a partir do nível ${next.level}` : ''}`} />;
  }
  // the boss is the match right after the ranked ones still to go
  const eta = interval ? (rankedBefore + 1) * interval : null;
  const total = threshold - 1;
  const done = Math.min(total, counter);
  return (
    <Kpi
      icon="👑"
      value={rankedBefore === 0 ? 'agora' : `${rankedBefore} PvP`}
      label={rankedBefore === 0 ? 'o próximo PvP é o boss' : 'até o próximo boss'}
      tone="gold"
      title={`BossPvpEncounter: ${counter} partidas ranqueadas contadas desde o último boss; ele entra quando o contador + 1 chega a ${threshold}. Enquanto você não tiver ${boss.drop}, ele volta.`}
      sub={
        <span className="flex flex-col gap-1">
          <span>
            {boss.name}
            {rankedBefore > 0 ? ` na ${rankedBefore + 1}ª luta de PvP` : ''}
            {eta ? ` · ≈${Math.round(eta / 60_000)} min` : ''}
          </span>
          <span className="flex items-center gap-[3px]" aria-label={`${done} de ${total} partidas contadas`}>
            {Array.from({ length: total }, (_, i) => (
              <i key={i} className={cn('inline-block h-1.5 w-1.5 rounded-full', i < done ? 'bg-gold' : 'bg-line-2')} />
            ))}
            <span className="ml-0.5 text-[10px] leading-none text-gold">♛</span>
          </span>
        </span>
      }
    />
  );
}
