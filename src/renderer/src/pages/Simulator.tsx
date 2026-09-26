import { useState } from 'react';
import type { AppSnapshot } from '@shared/contracts';
import { STAT_KEYS } from '@shared/combat';
import { NO_POINTS } from '@shared/plan-eval';
import { CATALOG_SECTORS, CONSUMABLES } from '../catalog';
import {
  EnemyTable,
  ItemPicker,
  PerkSlots,
  PlanSummary,
  PointSteppers,
  PotionPicker,
  SlotRow,
  StatusTable,
  SurvivalChart,
  SwapCard,
} from '../build-parts';
import { PotionSchedule } from '../potion-schedule';
import { OptimizerPanel } from '../optimizer-panel';
import { ARENA_SIZE, useArena, usePlanContext } from '../plan-context';
import { ARENA_TARGET, resetPlan, setPlan, usePlan } from '../plan-store';
import { usePlanEval } from '../use-optimizer';
import { Button, Chip, Empty, FilterChip, Grupo, Panel, cn, fmt, fmt1 } from '../ui';

/**
 * The simulator and the build planner in one page: the sector simulation of the equipped build and
 * of the plan side by side. The plan (items, perks, points, potions) is edited on the left — by hand,
 * or with what the optimizer found for the chosen goal — and every number it moves is in the one
 * status table on the right. Nothing is suggested until the optimizer runs.
 */
export function SimulatorPage({ snapshot }: { snapshot: AppSnapshot }) {
  const plan = usePlan();
  const arena = useArena(snapshot);
  const pc = usePlanContext(snapshot, plan, arena);
  const ev = usePlanEval(pc?.request ?? null, pc?.key ?? 'none');
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const [showPotions, setShowPotions] = useState(false);

  if (!pc) return <Empty>Sem save carregado.</Empty>;
  const { state } = pc;
  const cur = ev.current;
  const next = ev.planned;
  const metric = plan.metric;
  const unspent = state.unspentStatPoints;
  const owned = (state.ownedPerkIds ?? []).filter((id) => id > 0);
  const allocated = { hp: state.allocatedHp, atk: state.allocatedAtk, def: state.allocatedDef, crit: state.allocatedCrit, parry: state.allocatedParry };

  const setRespec = (on: boolean) => {
    // leaving a respec that took points off goes back to the game's allocation: half a respec means nothing
    setPlan((p) => ({ ...p, respec: on, points: on || STAT_KEYS.every((k) => p.points[k] >= 0) ? p.points : NO_POINTS }));
  };
  const placed = STAT_KEYS.reduce((a, k) => a + plan.points[k], 0);
  const totalPoints = STAT_KEYS.reduce((a, k) => a + allocated[k], 0) + unspent;
  const pointsFree = unspent - placed;
  const respecCost =
    state.respecCount === 0
      ? 'o seu primeiro respec é grátis'
      : `custa 60 Bloodmarks${state.respecCount === undefined ? ' (o primeiro é grátis)' : ''} · você tem ${fmt(state.pvpCurrency)}`;
  const setSlot = (slot: string, item: (typeof pc.slots)[number]['current']) =>
    setPlan((p) => {
      const items = { ...p.items };
      if (item) items[slot] = item;
      else delete items[slot];
      return { ...p, items };
    });

  // a piece can be in one slot only: the ones the plan wears elsewhere are not offered
  const takenOutside = (slot: string) => new Set(pc.slots.filter((x) => x.slot !== slot && x.planned).map((x) => x.planned!.uid));
  const chosenPotions = CONSUMABLES.filter((c) => (plan.potions ?? state.activeConsumableIds ?? []).includes(c.id));
  const bossNote = pc.boss
    ? `${pc.boss.resist ? `resiste ${pc.boss.resist}` : ''}${pc.boss.resist && pc.boss.weak ? ', ' : ''}${pc.boss.weak ? `fraco a ${pc.boss.weak}` : ''}${pc.bossDefeated ? ' · já derrotado' : ''}`
    : undefined;
  const scope = { bossName: pc.boss?.name, bossNote, sectorName: pc.sector.name, totalEnemies: pc.sector.totalEnemies, runs: plan.runs, startIndex: pc.startIndex, startHp: pc.startHp, arenaSize: arena.length || ARENA_SIZE, ...(pc.arena ? { arenaRecord: state.maxWaveRecord } : {}) };

  return (
    <div className="flex flex-col gap-3">
      <Panel title={pc.arena ? `Arena · até onde chega em ${fmt(plan.arenaHours)} h de autofight` : 'Sobrevivência no setor'}>
        {cur && pc.arena && cur.arena ? (
          <SurvivalChart
            height={200}
            cur={cur.survival}
            next={next?.arena ? next.survival : undefined}
            start={cur.arena.sim.firstWave - 1}
            total={cur.arena.sim.firstWave - 1 + Math.max(cur.survival.length, next?.survival.length ?? 0)}
            caption={`chance de ter passado da onda, em ${fmt(plan.arenaHours)} h (mortes voltam ao múltiplo de 5 abaixo)`}
            unit="ondas"
            endLabel="recorde esperado"
            endValue={(s) => `onda ${fmt1(s.reduce((a, v) => a + v, 0) + cur.arena!.sim.firstWave - 1)}`}
          />
        ) : cur && !pc.arena ? (
          <SurvivalChart
            height={200}
            cur={cur.survival}
            next={next?.survival}
            start={pc.startIndex}
            total={pc.sector.totalEnemies}
            here={pc.isCurrentSector ? state.sectorEnemy : undefined}
            windows={[
              ...(cur.potionWindow ? [{ from: cur.potionWindow.fromIndex, to: cur.potionEnd, planned: false }] : []),
              ...(next?.potionWindow ? [{ from: next.potionWindow.fromIndex, to: next.potionEnd, planned: true }] : []),
            ]}
          />
        ) : (
          <Empty>Simulando…</Empty>
        )}
      </Panel>
      <Panel title="Simulador" actions={ev.pending ? <Chip tone="warn">simulando…</Chip> : ev.ms ? <Chip>simulado em {fmt(ev.ms)} ms</Chip> : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="text-[10px] tracking-[0.7px] text-muted uppercase">setor</span>
            <select
              value={pc.arena ? ARENA_TARGET : pc.sector.id}
              onChange={(e) => setPlan((p) => ({ ...p, sectorId: Number(e.target.value) }))}
              className="h-8 cursor-pointer rounded-lg border border-gold bg-[#3a2c10] px-2 text-[13px] text-ink outline-none"
            >
              {CATALOG_SECTORS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.name}
                  {s.id === state.currentSector && !state.endlessMode ? ' (atual)' : ''}
                </option>
              ))}
              {(state.endlessMode || state.sectorCleared.every(Boolean)) && (
                <option value={ARENA_TARGET}>
                  Arena · onda {state.waveIndex}
                  {state.endlessMode ? ' (atual)' : ''}
                </option>
              )}
            </select>
          </label>
          <span className="mx-1 h-4 w-px bg-line" />
          <span className="text-[10px] tracking-[0.7px] text-muted uppercase">começar</span>
          <FilterChip on={!plan.fromCurrent || !pc.isCurrentSector} onClick={() => setPlan((p) => ({ ...p, fromCurrent: false }))}>
            {pc.arena ? `início da onda ${state.waveIndex}, vida cheia` : 'do início, vida cheia'}
          </FilterChip>
          {pc.isCurrentSector && (
            <FilterChip on={plan.fromCurrent} onClick={() => setPlan((p) => ({ ...p, fromCurrent: true }))}>
              {pc.arena
                ? `de onde estou · onda ${state.waveIndex}, ${state.waveKillCount ?? 0}/10, ${fmt(snapshot.live.player?.hp ?? state.currentHp)} PV`
                : `de onde estou · inimigo ${state.sectorEnemy}, ${fmt(snapshot.live.player?.hp ?? state.currentHp)} PV`}
            </FilterChip>
          )}
          {pc.arena && (
            <>
              <span className="mx-1 h-4 w-px bg-line" />
              <span className="text-[10px] tracking-[0.7px] text-muted uppercase">horas</span>
              {[1, 4, 12].map((h) => (
                <FilterChip key={h} on={plan.arenaHours === h} onClick={() => setPlan((p) => ({ ...p, arenaHours: h }))}>
                  {h} h
                </FilterChip>
              ))}
            </>
          )}
          <span className="mx-1 h-4 w-px bg-line" />
          <span className="text-[10px] tracking-[0.7px] text-muted uppercase">{pc.arena ? 'precisão' : 'voltas'}</span>
          {[500, 1000, 3000].map((n) => (
            <FilterChip key={n} on={plan.runs === n} onClick={() => setPlan((p) => ({ ...p, runs: n }))}>
              {pc.arena ? `${fmt(n / 5)} corridas` : fmt(n)}
            </FilterChip>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-3 min-[1180px]:grid-cols-[minmax(0,1fr)_440px] min-[1500px]:grid-cols-[minmax(0,1fr)_520px]">
        <Panel title="Planejar build" actions={<Chip>Monte Carlo</Chip>}>
          <OptimizerPanel snapshot={snapshot} pc={pc} plan={plan} />

          <div className={cn('flex flex-wrap items-center gap-2.5 rounded-lg border px-2.5 py-2', pc.changes ? 'border-[#4a3512] bg-[#221a0c]' : 'border-line bg-surface-2')}>
            {pc.changes ? (
              <>
                <span className="h-2 w-2 shrink-0 rounded-full bg-gold" />
                <span className="text-[13px]">
                  <b className="text-gold">
                    {pc.changes} {pc.changes === 1 ? 'mudança' : 'mudanças'} no plano.
                  </b>{' '}
                  <span className="text-muted">Nada muda no jogo: a coluna Planejada do Status mostra o efeito.</span>
                </span>
                <Button mini className="ml-auto" onClick={resetPlan}>
                  voltar ao atual
                </Button>
              </>
            ) : (
              <span className="text-[13px]">
                <b>Plano igual ao equipado.</b>{' '}
                <span className="text-muted">Escolha a meta e clique em otimizar, ou troque peças, perks, pontos e poções abaixo à mão.</span>
              </span>
            )}
          </div>
          {snapshot.live.status === 'live' && snapshot.live.equipment ? (
            <p className="m-0 text-[11px] leading-relaxed text-muted">
              Equipamento e perks lidos ao vivo do jogo{snapshot.save?.liveEquipment ? ' (o save ainda não gravou a última troca)' : ''}: uma troca feita no jogo aparece aqui na hora.
            </p>
          ) : (
            <p className="m-0 text-[11px] leading-relaxed text-muted">
              Trocou algo no jogo? O save só é gravado no fim de cada luta: até lá o Planner ainda vê o equipamento de antes. Com o modo ao vivo ligado ele lê a troca na hora.
            </p>
          )}
          {cur && next && <PlanSummary cur={cur} next={next} />}

          <Grupo nota={`${pc.slots.length} peças`}>Itens</Grupo>
          <div className="flex flex-col gap-1.5">
            {pc.slots.map((s) => {
              const list = openSlot === s.slot && (
                <ItemPicker
                  slot={s.slot}
                  current={s.current}
                  bag={pc.planState.inventory}
                  taken={takenOutside(s.slot)}
                  onPick={(item) => {
                    setSlot(s.slot, item.uid === s.current?.uid ? null : item);
                    setOpenSlot(null);
                  }}
                  onKeep={() => {
                    setSlot(s.slot, null);
                    setOpenSlot(null);
                  }}
                />
              );
              if (s.changed && s.planned) {
                return (
                  <div key={s.slot} className="flex flex-col gap-1">
                    <SwapCard
                      slot={s.slot}
                      current={s.current}
                      next={s.planned}
                      metric={metric}
                      mode="planned"
                      onUndo={() => setSlot(s.slot, null)}
                      onAlternatives={() => setOpenSlot(openSlot === s.slot ? null : s.slot)}
                    />
                    {list}
                  </div>
                );
              }
              return (
                <div key={s.slot} className="flex flex-col gap-1">
                  <SlotRow slot={s.slot} item={s.current} open={openSlot === s.slot} onToggle={() => setOpenSlot(openSlot === s.slot ? null : s.slot)} />
                  {list}
                </div>
              );
            })}
          </div>

          <Grupo nota={`${pc.plannedPerks.length} de ${Math.max(pc.equippedPerks.length, 3)}`}>Perks</Grupo>
          <PerkSlots planned={pc.plannedPerks} equipped={pc.equippedPerks} owned={owned} tiers={snapshot.combat.perkTiers} onChange={(ids) => setPlan((p) => ({ ...p, perks: ids }))} />

          <Grupo nota={plan.respec ? 'respec: todos os pontos de novo' : 'e se eu colocar pontos em…'}>Pontos</Grupo>
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip on={!plan.respec} onClick={() => setRespec(false)}>
              somar pontos
            </FilterChip>
            <FilterChip on={plan.respec} onClick={() => setRespec(true)}>
              respec
            </FilterChip>
            <span className="text-[11px] text-muted">
              {plan.respec ? `No jogo, o respec devolve todos os pontos para você distribuir de novo; ${respecCost}. O otimizador pode mover todos eles.` : unspent > 0 ? 'O otimizador distribui os pontos livres; com respec, pode mover todos.' : 'O otimizador só mexe nos pontos com respec.'}
            </span>
          </div>
          <PointSteppers points={plan.points} allocated={allocated} respec={plan.respec} onChange={(points) => setPlan((p) => ({ ...p, points }))} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-[12px] text-muted">
              {plan.respec
                ? `${fmt(totalPoints)} pontos no total · ${fmt(totalPoints - Math.max(0, pointsFree))} distribuídos · ${fmt(Math.max(0, pointsFree))} livres.`
                : unspent > 0
                  ? `${unspent} pontos livres no jogo.`
                  : 'Nenhum ponto livre agora: o que você somar aqui é só simulação.'}
              {pointsFree < 0 && ` ${fmt(-pointsFree)} além do que você tem: simula níveis futuros (5 por nível).`}
              {!plan.respec && ' O número cinza é o que já está distribuído.'}
            </span>
            <span className="ml-auto flex gap-1.5">
              {plan.respec && (
                <Button mini onClick={() => setPlan((p) => ({ ...p, points: Object.fromEntries(STAT_KEYS.map((k) => [k, -allocated[k]])) as typeof p.points }))}>
                  tirar tudo
                </Button>
              )}
              {STAT_KEYS.some((k) => plan.points[k] !== 0) && (
                <Button mini onClick={() => setPlan((p) => ({ ...p, points: NO_POINTS }))}>
                  {plan.respec ? 'como está no jogo' : 'zerar'}
                </Button>
              )}
            </span>
          </div>
          <Grupo nota={chosenPotions.length ? chosenPotions.map((c) => c.name).join(' · ') : 'nenhuma'}>Poções</Grupo>
          {showPotions ? (
            <>
              <PotionPicker
                picked={plan.potions ?? state.activeConsumableIds ?? []}
                active={state.activeConsumableIds ?? []}
                remaining={state.activeConsumableRemaining ?? []}
                onChange={(ids) => setPlan((p) => ({ ...p, potions: ids }))}
                onToggle={(id) =>
                  setPlan((p) => {
                    const cur = p.potions ?? state.activeConsumableIds ?? [];
                    return { ...p, potions: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
                  })
                }
              />
              <Button mini className="self-start" onClick={() => setShowPotions(false)}>
                fechar poções
              </Button>
            </>
          ) : (
            <div className="flex min-h-[44px] items-center gap-2.5 rounded-lg border border-dashed border-line-2 px-2.5 py-1.5">
              <span className="text-[12px] text-muted">
                {(state.activeConsumableIds ?? []).length ? 'As poções ativas no jogo já entram na conta.' : 'Nenhuma poção ativa no jogo.'} Marque outras para ver o efeito.
              </span>
              <Button mini className="ml-auto" onClick={() => setShowPotions(true)}>
                escolher poções
              </Button>
            </div>
          )}
          {pc.arena && plan.potions !== null && chosenPotions.some((c) => c.durationSec > 0) && (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              Na Arena as poções entram no começo e duram
              {[1, 2, 3].map((n) => (
                <FilterChip key={n} on={plan.potionDoses === n} onClick={() => setPlan((p) => ({ ...p, potionDoses: n }))}>
                  {n} {n === 1 ? 'dose' : 'doses'} ({2 * n} h)
                </FilterChip>
              ))}
            </div>
          )}
          {(next ?? cur) && !pc.arena && (
            <PotionSchedule
              planned={plan.potions !== null ? chosenPotions : []}
              from={plan.potionFrom}
              doses={plan.potionDoses}
              total={pc.sector.totalEnemies}
              outcome={(next ?? cur)!}
              activeLeft={pc.currentPotionSeconds}
              onStep={(d) => setPlan((p) => ({ ...p, potionFrom: Math.max(0, Math.min(pc.sector.totalEnemies - 1, p.potionFrom + d)) }))}
              onDoses={(n) => setPlan((p) => ({ ...p, potionDoses: n }))}
            />
          )}
          {snapshot.combat.perkEconomyV2 === false && (
            <div className="rounded-lg border border-[#5a3a34] bg-[#2a1712] px-3 py-2 text-[12px] text-down">
              O jogo está na versão 1 do balanceamento de perks. Os números fixos dos perks aqui são da versão 2: trate as projeções com cuidado.
            </div>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title="Status"
            actions={
              <span className="flex items-center gap-2.5 text-[11px] text-muted">
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-2 w-2 rounded-sm bg-muted" />
                  atual
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-2 w-2 rounded-sm bg-gold" />
                  planejada
                </span>
              </span>
            }
          >
            {cur ? <StatusTable cur={cur} next={next} scope={scope} /> : <Empty>Simulando…</Empty>}
            <p className="m-0 text-[11px] leading-relaxed text-muted">
              Atual é a build equipada agora (com as poções ativas). Planejada é a mesma build com o plano ao lado. Setor em {fmt(plan.runs)} voltas simuladas; PvP em lutas simuladas contra os{' '}
              {scope.arenaSize} últimos adversários.
            </p>
          </Panel>
        </div>
      </div>

      <Panel
        title={pc.arena ? `Inimigos da onda ${pc.arena.start.wave} · Arena` : `Inimigos do setor · ${pc.sector.name}`}
        actions={<Chip>{pc.arena ? `${cur?.odds.length ?? 0} possíveis · Blu e Viola` : `${pc.cats.length} categorias · 3 cores`}</Chip>}
      >
        {cur ? <EnemyTable cur={cur} next={next} /> : <Empty>Simulando…</Empty>}
        {pc.arena ? (
          <p className="m-0 text-[11px] leading-relaxed text-muted">
            Vitória com a vida cheia, luta a luta. Cada luta da Arena sorteia um setor (War Camp no começo, a Cave a partir da onda 50), uma das 5 categorias dele e a cor: 70% Blu na onda 1, 20% nas ondas
            31+, nunca Grigio. A vida e o ATK crescem com a onda, a DEF, o crítico e o parry não; nenhum resiste a elemento, e a fraqueza fica. As ondas 10, 20, 30 e 40 terminam num boss (uma vez por save).
          </p>
        ) : (
          <p className="m-0 text-[11px] leading-relaxed text-muted">
            Vitória com a vida cheia, luta a luta. A categoria de cada posição sai de uma curva centrada no progresso do setor e a cor depende do avanço dentro da faixa: no começo 80% Grigio, no fim 65% Blu e 35%
            Viola. Os stats são os do próprio jogo. Cada volta simulada leva a vida de uma luta para a outra, com a cura por acerto e a regeneração pós-luta.
          </p>
        )}
      </Panel>
    </div>
  );
}
