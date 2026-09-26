/**
 * "Otimizar para": pick a goal, run the optimizer, apply what it found.
 *
 * Nothing is suggested before the run. The search plays the Monte Carlo for every build it tries
 * (shared/deep-search.ts, on a pool of workers), which takes from seconds (PWR, the arena) to many
 * minutes (a tank's laps of the Cave), so it runs on a click, shows where it is, can be cancelled,
 * and hands the build it found to the plan: every changed slot shown as equipped → optimized.
 */
import { useEffect, useState } from 'react';
import type { AppSnapshot, SaveItem } from '@shared/contracts';
import { COMBAT, STAT_KEYS } from '@shared/combat';
import type { DeepContext } from '@shared/deep-eval';
import { goalScore, type Alloc, type DeepBuild, type DeepEval, type DeepGoal, type DeepSchedule } from '@shared/deep-search';
import { perkLoadoutOrders } from '@shared/perk-mods';
import { METRICS, STAT_LABEL, SwapCard, big, elementOf, lapTime, perkInfo, secs } from './build-parts';
import { poolSize } from './deep-pool';
import { Icon } from './icons';
import { cancelOptimizer, clearOptimizerResult, runOptimizer, useOptimizerJob, type OptimizerRun } from './optimizer-job';
import type { PlanContext } from './plan-context';
import { setPlan, type Plan } from './plan-store';
import { Button, Chip, FilterChip, cn, fmt, fmt1, rarityColor } from './ui';

const pct = (x: number) => `${fmt1(x * 100)}%`;
const signed = (x: number, f: (v: number) => string = fmt) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${f(Math.abs(x))}`;
const ALLOC_KEY = { hp: 'allocatedHp', atk: 'allocatedAtk', def: 'allocatedDef', crit: 'allocatedCrit', parry: 'allocatedParry' } as const;

/** What the Monte Carlo plays for each goal, in one line. */
const GOAL_PLAY: Record<DeepGoal, string> = {
  farm: 'XP por hora do ciclo real (luta até morrer, o setor recomeça), jogando tentativas inteiras',
  progress: 'a chance de fechar o setor e as lutas vencidas por volta, jogando voltas inteiras',
  pvp: 'a chance de vitória contra os últimos adversários da arena, em lutas simuladas',
  boss: 'a chance de vencer o boss de PvP da sua faixa, em lutas simuladas',
  damage: 'o dano por round contra os inimigos do setor, em lutas simuladas',
  survival: 'a vida por luta (com cura e regeneração) contra os inimigos do setor, em lutas simuladas',
  power: 'o PWR do jogo (uma fórmula: não precisa de sorteio)',
};

/** How the final measure was played, for the "(…)" after the numbers. */
function finalLaps(goal: DeepGoal, arenaHours?: number): string {
  switch (goal) {
    case 'progress':
      return arenaHours ? `1.000 corridas de ${fmt(arenaHours)} h` : '1.000 voltas';
    case 'farm':
      return '1.000 tentativas';
    case 'pvp':
      return '500 lutas por adversário';
    case 'boss':
      return '8.000 lutas';
    case 'damage':
    case 'survival':
      return '500 lutas por inimigo';
    default:
      return 'fórmula do jogo';
  }
}

/** A measure in the goal's own words. */
export function goalValue(goal: DeepGoal, e: DeepEval, startIndex = 0, arena = false): string {
  switch (goal) {
    case 'farm':
      return `${big(e.value)} XP/h`;
    case 'progress':
      // the Arena scores progress in kills (10 a wave); value is the record at the end
      if (arena) return `recorde onda ${fmt1(e.value)} · ${fmt1(e.depth / 10)} ondas completas`;
      return `fecha ${pct(e.clear)} · chega ao inimigo ${fmt1(startIndex + e.depth)}`;
    case 'pvp':
    case 'boss':
      return `${pct(e.value)} de vitória`;
    case 'damage':
      return `${fmt1(e.value)} de dano por round`;
    case 'survival':
      return `${signed(e.value)} PV por luta`;
    default:
      return `${fmt(e.value)} PWR`;
  }
}

function Piece({ item, label }: { item: SaveItem | null; label: string }) {
  const el = item ? elementOf(item) : null;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1">
      <Icon family="items" id={item?.templateId} />
      <span className="flex min-w-0 flex-col">
        <span className="text-[9px] tracking-[0.6px] text-muted uppercase">
          {label}
          {el && (
            <span
              className="text-xp"
              title={item?.slot === 3 ? 'arma: o elemento pesa contra a resistência e a fraqueza do inimigo' : 'fora das armas o elemento só vale para as sinergias ("for every other X item"); o inimigo não resiste a ele'}
            >
              {' '}
              · {el}
              {item?.slot !== 3 && <span className="text-muted"> (sinergia)</span>}
            </span>
          )}
        </span>
        <span className="truncate text-[12px] leading-tight font-semibold" style={item ? { color: rarityColor(item.rarity) } : undefined}>
          {item?.itemName ?? 'vazio'}
        </span>
      </span>
    </span>
  );
}

const Arrow = () => (
  <span className="shrink-0 text-gold" aria-hidden="true">
    →
  </span>
);

function PerkList({ ids, label, tiers }: { ids: number[]; label: string; tiers?: Record<number, number> }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-line bg-surface-2 px-2 py-1">
      <span className="text-[9px] tracking-[0.6px] text-muted uppercase">{label}</span>
      {ids.length ? (
        ids.map((id) => (
          <span key={id} className="flex items-center gap-1">
            <Icon family="perks" id={id} />
            <span className="text-[12px] leading-tight font-semibold">{perkInfo(id, tiers).name}</span>
          </span>
        ))
      ) : (
        <span className="text-[12px] text-muted">nada</span>
      )}
    </span>
  );
}

export function OptimizerPanel({ snapshot, pc, plan }: { snapshot: AppSnapshot; pc: PlanContext; plan: Plan }) {
  const job = useOptimizerJob();
  const [open, setOpen] = useState<string | null>(null);
  const [, tick] = useState(0);
  // the clock of a run moves once a second
  useEffect(() => {
    if (!job.running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.running]);

  const goal = plan.metric;
  const ps = pc.planState;
  const save = pc.state;
  const tiers = snapshot.combat.perkTiers;
  const bagByUid = new Map(ps.inventory.map((i) => [i.uid, i]));
  const allocOf = (s: typeof save): Alloc => ({ hp: s.allocatedHp, atk: s.allocatedAtk, def: s.allocatedDef, crit: s.allocatedCrit, parry: s.allocatedParry });
  const gameAlloc = allocOf(save);
  const unspent = save.unspentStatPoints;
  const gameTotal = STAT_KEYS.reduce((a, k) => a + gameAlloc[k], 0) + unspent;
  const timedPotions = plan.potions !== null ? pc.plannedPotions.filter((c) => c.durationSec > 0) : [];
  const schedule: DeepSchedule | null = goal === 'progress' && timedPotions.length && !pc.arena ? { fromIndex: plan.potionFrom, doses: Math.max(1, plan.potionDoses) } : null;
  const respecCost = save.respecCount === 0 ? 'o primeiro respec é grátis' : `respec: 60 Bloodmarks (você tem ${fmt(save.pvpCurrency)})`;
  const label = (g: DeepGoal) => METRICS.find((m) => m.id === g)?.label ?? g;
  const usesPotions = goal === 'progress' || goal === 'farm' || goal === 'damage' || goal === 'survival';
  const blocked = goal === 'pvp' && !pc.gear.pvpPool?.length ? 'Ainda não há lutas de PvP registradas para simular a arena.' : goal === 'boss' && !pc.boss ? 'Não há boss de PvP para o seu nível.' : null;
  const pointsLine = plan.respec
    ? `respec: os ${fmt(gameTotal)} pontos podem mudar (${respecCost})`
    : unspent > 0
      ? `${fmt(unspent)} pontos livres para distribuir`
      : 'os pontos ficam como estão';

  const run = () => {
    const start: DeepBuild = { uids: [...ps.equippedUids], perks: [...pc.plannedPerks], alloc: allocOf(ps) };
    const equipped: DeepBuild = { uids: [...save.equippedUids], perks: [...pc.equippedPerks], alloc: gameAlloc };
    const floor: Alloc = plan.respec ? { hp: 0, atk: 0, def: 0, crit: 0, parry: 0 } : gameAlloc;
    const ctx: DeepContext = {
      goal,
      state: ps,
      sector: pc.sector,
      cats: pc.cats,
      regenTable: snapshot.combat.regenPct?.length ? snapshot.combat.regenPct : COMBAT.REGEN_PCT_BY_SECTOR,
      weakBothPct: snapshot.combat.weakBothPct,
      potions: usesPotions ? pc.plannedPotions : [],
      perkWeights: pc.perkWeights,
      startIndex: pc.startIndex,
      startHp: pc.startHp,
      pvpPool: goal === 'pvp' ? pc.gear.pvpPool : [],
      bossPool: goal === 'boss' ? pc.gear.bossPool : [],
      ...(pc.arena ? { arena: pc.arena, potionDoses: plan.potionDoses } : {}),
    };
    setOpen(null);
    void runOptimizer(
      {
        goal,
        slots: ps.equippedSlots,
        bag: ps.inventory,
        start,
        equipped,
        owned: (save.ownedPerkIds ?? []).filter((id) => id > 0),
        points: plan.respec || unspent > 0 ? { floor, total: gameTotal } : null,
        schedule,
        totalEnemies: pc.sector.totalEnemies,
        startIndex: pc.startIndex,
        perkName: (id) => perkInfo(id, tiers).name,
        perkOrders: perkLoadoutOrders,
      },
      ctx,
      {
        slots: ps.equippedSlots,
        sectorName: pc.arena ? `Arena, onda ${pc.arena.start.wave}` : pc.sector.name,
        totalEnemies: pc.sector.totalEnemies,
        startIndex: pc.startIndex,
        schedule,
        ...(pc.arena ? { arenaHours: pc.arena.hours } : {}),
      },
      snapshot.combat.perkTexts,
    );
  };

  // the answer into the plan: the pieces, the perks, the points (a respec when a stat loses points)
  const apply = (r: OptimizerRun, sched?: DeepSchedule) => {
    const b = r.end;
    setPlan((p) => {
      const items: Record<string, SaveItem> = {};
      b.uids.forEach((uid, i) => {
        const slot = r.slots[i]!;
        const item = bagByUid.get(uid);
        if (item && save.equippedUids[i] !== uid) items[slot] = item;
      });
      const points = Object.fromEntries(STAT_KEYS.map((k) => [k, b.alloc[k] - save[ALLOC_KEY[k]]])) as Plan['points'];
      const same = b.perks.length === pc.equippedPerks.length && b.perks.every((id) => pc.equippedPerks.includes(id));
      return {
        ...p,
        items,
        perks: same ? null : b.perks,
        points,
        respec: p.respec || STAT_KEYS.some((k) => points[k] < 0),
        ...(sched ? { potionFrom: sched.fromIndex, potionDoses: sched.doses } : {}),
      };
    });
  };

  const r = job.result;
  const progress = job.progress;
  const bar = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  const phaseLabel = progress?.phase === 'schedule' ? 'horário das poções' : progress?.phase === 'confirm' ? 'conferindo' : progress?.phase === 'perks' ? 'todos os perks' : `rodada ${(progress?.round ?? 0) + 1}`;
  const elapsed = job.startedAt ? Math.max(0, (Date.now() - job.startedAt) / 1000) : 0;
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-bg-2 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] tracking-[0.7px] text-muted uppercase">otimizar para</span>
        {METRICS.map((m) => (
          <FilterChip key={m.id} on={goal === m.id} onClick={() => setPlan((p) => ({ ...p, metric: m.id }))}>
            <span title={m.hint}>{m.label}</span>
          </FilterChip>
        ))}
      </div>
      <p className="m-0 text-[12px] leading-relaxed text-muted">
        {goal === 'power' ? (
          <>
            A busca parte do plano e procura {GOAL_PLAY[goal]}: uma peça por vez, pares de armas, conjuntos de um elemento, um perk por outro{plan.respec || unspent > 0 ? ' e pontos' : ''}.
          </>
        ) : (
          <>
            A busca parte do plano e mede, no Monte Carlo,{' '}
            {pc.arena && goal === 'progress' ? `até onde a Arena chega em ${fmt(pc.arena.hours)} h de autofight (cada morte volta ao múltiplo de 5 abaixo da onda)` : GOAL_PLAY[goal]}: uma peça por vez, pares de armas, conjuntos de um elemento, um perk por outro{plan.respec || unspent > 0 ? ' e pontos' : ''}. Cada
            troca é jogada em algumas voltas, as melhores em mais e de novo em 300 com outros dados, e só entra se ganhar nessas mesmas voltas.
            {goal === 'progress' || goal === 'farm'
              ? ` Leva de alguns minutos a mais de meia hora (as lutas longas de uma build tanque são as mais lentas); usa ${poolSize()} núcleos.`
              : ` Leva de segundos a poucos minutos; usa ${poolSize()} núcleos.`}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>pontos: {pointsLine}</span>
        {usesPotions && (
          <>
            <span className="h-3 w-px bg-line" />
            <span>
              poções:{' '}
              {pc.plannedPotions.length
                ? `${pc.plannedPotions.map((c) => c.name).join(' + ')}${schedule ? ` · ${schedule.doses} ${schedule.doses === 1 ? 'dose' : 'doses'} no inimigo ${schedule.fromIndex} (a busca testa outros horários no fim)` : ''}`
                : 'nenhuma'}
            </span>
          </>
        )}
        {goal === 'progress' && pc.startIndex > 0 && (
          <>
            <span className="h-3 w-px bg-line" />
            <span>
              começa no inimigo {pc.startIndex} com {fmt(pc.startHp ?? 0)} PV
            </span>
          </>
        )}
        <span className="ml-auto flex gap-1.5">
          {job.running ? (
            <Button mini onClick={cancelOptimizer}>
              cancelar
            </Button>
          ) : (
            <Button mini primary onClick={run} disabled={Boolean(blocked)} title={blocked ?? undefined}>
              otimizar para {label(goal)}
            </Button>
          )}
        </span>
      </div>
      {blocked && <div className="text-[12px] text-down">{blocked}</div>}

      {job.running && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Chip tone="warn">
              {label(job.goal ?? goal)} · {phaseLabel}
            </Chip>
            {progress?.now && job.goal && <span className="num text-muted">agora: {goalValue(job.goal, progress.now, pc.startIndex, Boolean(pc.arena))}</span>}
            <span className="num ml-auto text-[11px] text-muted">
              {clock(elapsed)} · {progress ? `${fmt(progress.done)} / ${fmt(progress.total)}` : 'preparando…'}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full bg-gold transition-[width]" style={{ width: `${bar * 100}%` }} />
          </div>
          {job.log.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11px] text-muted">
              {job.log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {job.error && <div className="text-[12px] text-down">A otimização falhou: {job.error}</div>}

      {r && !job.running && <Result r={r} planGoal={goal} save={save} bagByUid={bagByUid} tiers={tiers} respecCost={respecCost} open={open} setOpen={setOpen} onApply={apply} label={label} />}
    </div>
  );
}

function Result({
  r,
  planGoal,
  save,
  bagByUid,
  tiers,
  respecCost,
  open,
  setOpen,
  onApply,
  label,
}: {
  r: OptimizerRun;
  planGoal: DeepGoal;
  save: PlanContext['state'];
  bagByUid: Map<number, SaveItem>;
  tiers?: Record<number, number>;
  respecCost: string;
  open: string | null;
  setOpen: (s: string | null) => void;
  onApply: (r: OptimizerRun, sched?: DeepSchedule) => void;
  label: (g: DeepGoal) => string;
}) {
  const equippedPerks = (save.equippedPerkIds ?? []).filter((id) => id > 0);
  // everything the found build changes against the game, slot by slot
  const swaps = r.slots.flatMap((slot, i) => {
    const uid = r.end.uids[i]!;
    const from = bagByUid.get(save.equippedUids[i] ?? -1) ?? null;
    if (uid === (save.equippedUids[i] ?? -1)) return [];
    return [{ slot, from, to: bagByUid.get(uid) ?? null }];
  });
  const perksOut = equippedPerks.filter((id) => !r.end.perks.includes(id));
  const perksIn = r.end.perks.filter((id) => !equippedPerks.includes(id));
  const points = STAT_KEYS.map((k) => ({ k, from: save[ALLOC_KEY[k]], to: r.end.alloc[k] })).filter((x) => x.from !== x.to);
  const respec = points.some((x) => x.to < x.from);
  const nothing = !swaps.length && !perksOut.length && !perksIn.length && !points.length;
  const base = r.equippedEval ?? r.startEval;
  const gained = goalScore(r.goal, r.endEval) - goalScore(r.goal, base);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[#2f4a24] bg-[#131a0f] px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Chip tone="up">{label(r.goal)}</Chip>
        <span className="num text-[13px]">
          <span className="text-muted">equipado</span> <b>{goalValue(r.goal, base, r.startIndex, r.arenaHours !== undefined)}</b> → <span className="text-muted">otimizado</span>{' '}
          <b className={gained >= 0 ? 'text-gold' : 'text-down'}>{goalValue(r.goal, r.endEval, r.startIndex, r.arenaHours !== undefined)}</b>
        </span>
        <span className="num text-[11px] text-muted">
          ({finalLaps(r.goal, r.arenaHours)}
          {r.schedule ? `, ${r.schedule.doses} ${r.schedule.doses === 1 ? 'dose' : 'doses'} no inimigo ${r.schedule.fromIndex}` : ''}
          {r.goal === 'progress' && r.endEval.lapSeconds !== null ? ` · volta de ~${lapTime(r.endEval.lapSeconds)}` : ''} · {fmt(r.evaluations)} builds testadas em {secs(r.seconds)} · {r.sectorName})
        </span>
      </div>
      {r.equippedEval && (
        <div className="num text-[11px] text-muted">
          O plano de onde a busca partiu: {goalValue(r.goal, r.startEval, r.startIndex, r.arenaHours !== undefined)}.
        </div>
      )}
      {r.goal !== planGoal && <div className="text-[11px] text-gold">Este resultado é para {label(r.goal)}; a meta escolhida agora é {label(planGoal)}.</div>}

      {nothing ? (
        <div className="text-[12px] text-muted">
          <b className="text-up">Nada a trocar.</b> Nenhuma troca da bolsa melhora {label(r.goal)}: o equipado já é o melhor que a busca achou.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] tracking-[0.7px] text-muted uppercase">o que muda em relação ao equipado</span>
          {swaps.map((s) => (
            <div key={s.slot} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="w-[58px] shrink-0 text-[10px] tracking-[0.5px] text-muted uppercase">{s.slot}</span>
                <Piece item={s.from} label="atual" />
                <Arrow />
                <Piece item={s.to} label="otimizado" />
                {s.to && (
                  <Button mini onClick={() => setOpen(open === s.slot ? null : s.slot)}>
                    {open === s.slot ? 'fechar' : 'ver as duas'}
                  </Button>
                )}
              </div>
              {open === s.slot && s.to && <SwapCard slot={s.slot} current={s.from} next={s.to} metric={r.goal} mode="preview" badge="otimizado" nextLabel="otimizado" onClose={() => setOpen(null)} />}
            </div>
          ))}
          {(perksOut.length > 0 || perksIn.length > 0) && (
            <div className="flex items-center gap-2">
              <span className="w-[58px] shrink-0 text-[10px] tracking-[0.5px] text-muted uppercase">perks</span>
              <PerkList ids={perksOut} label="sai" tiers={tiers} />
              <Arrow />
              <PerkList ids={perksIn} label="entra" tiers={tiers} />
            </div>
          )}
          {r.end.perks.includes(26) && (
            <div className="text-[12px]">
              <span className="text-muted">ordem dos slots (da esquerda para a direita): </span>
              {r.end.perks.map((id) => perkInfo(id, tiers).name).join(' · ')}
              <span className="text-muted">
                {' '}
                — o Eco Espelhado copia o perk à esquerda
                {r.end.perks.indexOf(26) > 0 ? ` (${perkInfo(r.end.perks[r.end.perks.indexOf(26) - 1]!, tiers).name})` : ''}.
              </span>
            </div>
          )}
          {points.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="w-[58px] shrink-0 text-[10px] tracking-[0.5px] text-muted uppercase">pontos</span>
              <span className="num flex flex-wrap gap-x-3 text-[12px]">
                {points.map((x) => (
                  <span key={x.k}>
                    {STAT_LABEL[x.k]} {fmt(x.from)} → <b className="text-gold">{fmt(x.to)}</b>
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {r.steps.length > 0 && (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer">como a busca chegou lá ({r.steps.length} {r.steps.length === 1 ? 'passo' : 'passos'})</summary>
          <ol className="m-0 mt-1 flex list-decimal flex-col gap-0.5 pl-5">
            {r.steps.map((s, i) => (
              <li key={i}>
                {s.label} <span className="num">→ {goalValue(r.goal, s.eval, r.startIndex, r.arenaHours !== undefined)} (300 {r.goal === 'progress' ? (r.arenaHours !== undefined ? 'corridas' : 'voltas') : r.goal === 'farm' ? 'tentativas' : 'rodadas de lutas'})</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {r.schedules && r.schedules.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] tracking-[0.7px] text-muted uppercase">quando tomar as poções (300 voltas cada)</span>
          <div className="flex flex-wrap gap-1.5">
            {r.schedules.slice(0, 6).map((row, i) => {
              const mine = r.schedule && row.fromIndex === r.schedule.fromIndex && row.doses === r.schedule.doses;
              return (
                <button
                  key={`${row.doses}-${row.fromIndex}`}
                  type="button"
                  onClick={() => onApply(r, row)}
                  title="usar este horário no plano (com a build encontrada)"
                  className={cn('num cursor-pointer rounded-lg border px-2 py-1 text-left text-[11px]', i === 0 ? 'border-gold bg-[#3a2c10]' : 'border-line bg-surface-2', mine && 'outline outline-1 outline-xp')}
                >
                  <b className={i === 0 ? 'text-gold' : 'text-ink'}>{pct(row.clear)}</b> · {row.doses} {row.doses === 1 ? 'dose' : 'doses'} no inimigo {row.fromIndex}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!nothing && (
          <Button mini primary onClick={() => onApply(r, r.schedules?.[0])}>
            aplicar ao plano{r.schedules?.[0] ? ' (com o melhor horário)' : ''}
          </Button>
        )}
        <Button mini onClick={clearOptimizerResult}>
          descartar
        </Button>
        <span className="text-[11px] text-muted">
          {respec ? `Pede um respec (${respecCost}). ` : ''}
          {nothing ? '' : 'O status e o gráfico ao lado passam a mostrar a build otimizada; nada muda no jogo.'}
        </span>
      </div>
    </div>
  );
}
