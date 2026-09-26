import { useMemo } from 'react';
import { ARENA_BOSS_EVERY_WAVES, ARENA_ENEMIES_PER_WAVE, arenaCheckpoint } from '@shared/arena';
import { classifyBattles, pvpInterval } from '@shared/battles';
import { RARITIES, type AppSnapshot } from '@shared/contracts';
import { MAX_LEVEL, estimateBuild, inventoryCapForLevel, xpNeededForNextLevel } from '@shared/game-math';
import { levelEta } from '@shared/level-eta';
import { xpWindow } from '@shared/session-window';
import { buildPerks } from '../combat-profile';
import { sector } from '../catalog';
import { CombatLog, TallyRow } from '../combat-log';
import { EventRow } from '../events';
import { LevelGoal, hours } from '../level-goal';
import { NextBossKpi } from '../next-boss';
import { Bar, Button, Chip, Empty, Grupo, IconBox, Kpi, Panel, RarityName, Stat, ago, fmt, fmt1 } from '../ui';

const ENEMY_COLOR_VAR = (c: string | null) => `var(--color-enemy-${Math.max(0, ['Grigio', 'Blu', 'Viola'].indexOf(c ?? 'Grigio'))})`;

export function OverviewPage({ snapshot, now }: { snapshot: AppSnapshot; now: number }) {
  const { save, live, stats, xpTable } = snapshot;
  const rows = useMemo(() => classifyBattles(snapshot.events, snapshot.pvp), [snapshot.events, snapshot.pvp]);
  // the loop's PvP rhythm, from the fights in the snapshot, for the boss countdown's time estimate
  const interval = useMemo(() => pvpInterval(rows), [rows]);
  const lvlNow = live.status === 'live' && live.player ? live.player.level : save?.state.level;
  const xpNow = live.status === 'live' && live.player ? live.player.xp : save?.state.xp;
  // the level-60 ETA moves with the clock (an idle hour slows it), so it is re-read every half minute
  const tick = Math.floor(now / 30_000);
  const eta = useMemo(() => {
    if (lvlNow === undefined || xpNow === undefined || lvlNow >= MAX_LEVEL) return null;
    // the farm's last hour from the history, whether or not the session counters were zeroed; the
    // snapshot keeps the last 300 events, so never claim an hour they do not cover
    const since = snapshot.events.length ? Date.parse(snapshot.events[0]!.t) : undefined;
    return levelEta(rows, { level: lvlNow, xp: xpNow, now: tick * 30_000, since, neededNow: xpTable[lvlNow] });
  }, [rows, lvlNow, xpNow, tick, snapshot.events, xpTable]);
  if (!save) return <Empty>{snapshot.saveError ?? 'Aguardando o save do Lootborne…'}</Empty>;

  const s = save.state;
  const build = estimateBuild(s, undefined, buildPerks(snapshot));
  const player = live.status === 'live' ? live.player : undefined;
  const hp = player?.hp ?? s.currentHp;
  const stamina = player?.stamina ?? s.stamina;
  const xp = player?.xp ?? s.xp;
  const level = player?.level ?? s.level;
  // the game's figure when the live tap has seen it, else XPSystem's curve
  const xpNeeded = level >= MAX_LEVEL ? null : (xpTable[level] ?? xpNeededForNextLevel(level));
  const maxHp = Math.max(Math.round(build.stats.hp), hp); // perks/buffs the estimate misses
  const sec = sector(s.currentSector);
  const cap = inventoryCapForLevel(s.level);
  // the next level at the last hour's pace (level-eta), else at the session's
  const etaHours = eta?.steps[0]?.hours ?? (xpNeeded && stats.xpPerHour > 0 ? (xpNeeded - xp) / stats.xpPerHour : null);
  const enemy = live.status === 'live' ? live.enemy : undefined;
  const recent = snapshot.events.slice(-14).reverse();
  // derived here, not in the snapshot: a 10-minute figure has to decay with the clock, and
  // snapshots only go out when the save is written (~18 s) — or not at all while the game is idle.
  const w10 = xpWindow(snapshot.events, stats.startedAt, now);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 min-[1400px]:grid-cols-7">
        <Kpi icon="🗡️" value={s.battleActive ? 'Lutando' : 'Pausado'} label="estado da batalha" tone={s.battleActive ? 'good' : 'alerta'} sub={live.autofight ? `autofight ${live.autofight.on ? 'ligado' : 'desligado'}` : undefined} />
        <Kpi icon="⚡" value={fmt(live.power ?? build.power)} label={live.power !== undefined ? 'poder (jogo)' : 'poder (estimado)'} tone="gold" />
        <Kpi icon="⭐" value={level} label="nível" sub={xpNeeded ? `${fmt(xp)} / ${fmt(xpNeeded)} XP` : level >= MAX_LEVEL ? 'nível máximo' : `${fmt(xp)} XP`} tone="xp" />
        <Kpi icon="❤️" value={`${fmt(hp)} / ${fmt(maxHp)}`} label="vida" tone={hp < maxHp * 0.3 ? 'alerta' : undefined} />
        <Kpi icon="🔋" value={fmt1(stamina)} label="stamina" tone={stamina < 20 ? 'alerta' : undefined} />
        <Kpi icon="🎒" value={`${s.inventory.length}/${cap}`} label="bolsa" tone={s.inventory.length >= cap * 0.9 ? 'alerta' : undefined} sub={s.unspentStatPoints > 0 ? `${s.unspentStatPoints} pontos livres` : undefined} />
        <div className="md:col-span-2 min-[1400px]:col-span-1 [&>*]:h-full">
          <NextBossKpi state={s} interval={interval} />
        </div>
      </div>

      <Grupo
        nota={
          <span className="flex items-center gap-2">
            desde {new Date(stats.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · janelas de 10 e 30 min
            <Button
              mini
              onClick={() => void window.planner.resetStats()}
              title="Zera XP, lutas, drops, mortes e PvP da sessão e recomeça as duas janelas. Os eventos da timeline não são apagados."
            >
              zerar contagem
            </Button>
          </span>
        }
      >
        Sessão
      </Grupo>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <RateCard icon="⏱️" title="XP nos últimos 10 min" value={fmt(w10.xp)} tone="xp" detail={windowDetail(w10)} />
        <RateCard icon="📈" title="XP / hora" value={fmt(stats.xpPerHour)} tone="xp" detail={etaHours !== null ? `próximo nível em ~${hours(etaHours)}` : `${fmt(stats.xpGained)} XP na sessão`} />
        <RateCard icon="⚔️" title="Lutas / hora" value={fmt(stats.battlesPerHour)} tone="ink" detail={`${fmt(stats.battles)} ${stats.battles === 1 ? 'luta' : 'lutas'} · ${fmt(stats.deaths)} ${stats.deaths === 1 ? 'morte' : 'mortes'}`} />
        <RateCard icon="🎁" title="Drops / hora" value={fmt1(stats.dropsPerHour)} tone="gold" detail={stats.lastDropAt ? `último há ${ago(stats.lastDropAt, now)}` : 'nenhum drop ainda'} />
      </div>
      {eta && <LevelGoal eta={eta} sectorsCleared={s.sectorCleared} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <Stat label="Sem drop há" value={`${s.killsWithoutDrop} lutas`} tone="accent" destaque={s.killsWithoutDrop >= 8} />
        {s.endlessMode ? (
          <Stat label="Recorde na Arena" value={`onda ${fmt(s.maxWaveRecord)}`} tone="accent" hint={`agora na onda ${s.waveIndex}; uma morte volta à onda ${arenaCheckpoint(s.waveIndex)}`} />
        ) : (
          <Stat label="Mortes no setor" value={fmt(s.deathsInSectorPersistent)} tone={s.deathsInSectorPersistent ? 'down' : undefined} hint={`${fmt(s.fightsInSectorPersistent)} lutas no setor`} />
        )}
        <Stat label="PvP na sessão" value={`${stats.pvpWins}V · ${stats.pvpLosses}D`} />
        <Stat label="Bloodmarks" value={fmt(s.pvpCurrency)} tone="accent" />
        <div className="flex flex-wrap content-center items-center gap-1.5 rounded-[10px] border border-line bg-surface px-3 py-2">
          {RARITIES.some((r) => stats.drops[r]) ? (
            RARITIES.map((r) =>
              stats.drops[r] ? (
                <Chip key={r}>
                  <RarityName rarity={r}>{r}</RarityName> ×{stats.drops[r]}
                </Chip>
              ) : null,
            )
          ) : (
            <span className="text-[11px] text-muted">drops da sessão aparecem aqui</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.35fr]">
        <Panel
          title={s.endlessMode ? `Arena · onda ${s.waveIndex}` : sec ? `Setor ${s.currentSector} · ${sec.name}` : `Setor ${s.currentSector}`}
          actions={s.endlessMode ? <Chip tone="accent">recorde: onda {fmt(s.maxWaveRecord)}</Chip> : undefined}
        >
          {s.endlessMode ? (
            <>
              <Bar label={`Onda ${s.waveIndex}`} value={s.waveKillCount ?? 0} max={ARENA_ENEMIES_PER_WAVE} right={`${s.waveKillCount ?? 0} / ${ARENA_ENEMIES_PER_WAVE} inimigos`} />
              <div className="text-[11px] leading-relaxed text-muted">
                Todos os setores fechados: a Arena sobe uma onda a cada {ARENA_ENEMIES_PER_WAVE} vitórias, sem fim, com inimigos mais fortes a cada onda e um boss a cada {ARENA_BOSS_EVERY_WAVES} ondas
                {` (o próximo na onda ${Math.ceil(s.waveIndex / ARENA_BOSS_EVERY_WAVES) * ARENA_BOSS_EVERY_WAVES})`}.
              </div>
            </>
          ) : (
            <Bar label="Progresso do setor" value={s.sectorEnemy} max={sec?.totalEnemies ?? 1} right={`${s.sectorEnemy} / ${sec?.totalEnemies ?? '?'}`} />
          )}
          {enemy ? (
            <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-bg-2 p-3">
              <div className="flex items-center gap-2.5">
                <IconBox>{enemy.isPvP ? '🤺' : '👹'}</IconBox>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold" style={{ color: ENEMY_COLOR_VAR(enemy.color) }}>
                    {enemy.name ?? 'Inimigo'}
                  </div>
                  <div className="text-[10px] tracking-[0.7px] text-muted uppercase">
                    {enemy.isPvP ? 'PvP em segundo plano' : `nível ${enemy.level} · ${enemy.color}`}
                  </div>
                </div>
                {!enemy.isPvP && <Chip tone="info">drop {fmt1(enemy.dropChance * 100)}%</Chip>}
              </div>
              <Bar value={enemy.hp} max={enemy.maxHp} color="linear-gradient(90deg,#7a2a22,var(--color-hp))" right={`${fmt(enemy.hp)} / ${fmt(enemy.maxHp)}`} label="vida do inimigo" />
              <div className="flex flex-wrap gap-1.5">
                {!enemy.isPvP && <Chip>+{fmt(enemy.xpWin)} XP</Chip>}
                {enemy.atk !== undefined && <Chip tone="down">ATK {fmt1(enemy.atk)}</Chip>}
                {enemy.def !== undefined && <Chip tone="down">DEF {fmt1(enemy.def)}</Chip>}
                {enemy.crit ? <Chip tone="down">crit {fmt1(enemy.crit)}%</Chip> : null}
                {enemy.parry ? <Chip tone="down">parry {fmt1(enemy.parry)}%</Chip> : null}
                {!live.inCombat && <Chip>fora de combate</Chip>}
              </div>
            </div>
          ) : (
            <div className="rounded-[10px] border border-dashed border-line-2 p-3 text-xs text-muted">
              {live.status === 'live' ? 'Esperando a próxima luta…' : 'Ligue o modo ao vivo (Alertas & Ao vivo) para ver o inimigo atual, a vida dele e cada turno.'}
            </div>
          )}
          {sec && !s.endlessMode && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              drops aqui:
              {(['common', 'rare', 'epic', 'legendary', 'mythic'] as const).map((k, i) =>
                sec.dropPct[k] > 0 ? (
                  <span key={k} className="num">
                    <RarityName rarity={i}>{RARITIES[i]}</RarityName> {fmt1(sec.dropPct[k])}%
                  </span>
                ) : null,
              )}
              · ao concluir <RarityName rarity={sec.clearRewardRarity}>{sec.clearRewardRarity}</RarityName>
            </div>
          )}
          <div className="text-[11px] leading-relaxed text-muted" title="O jogo só dá o alívio de quem está travado quando o jogador age de verdade (forjar, desmontar, loja, perks); isso fica com você.">
            🧱 Anti-AFK: {s.muratoBattlesSinceProgress} lutas sem progresso · {s.muratoBattlesSinceAction} sem ação
          </div>
        </Panel>

        <LiveCombat snapshot={snapshot} hp={hp} maxHp={maxHp} />
      </div>

      <Panel title="Últimos eventos">
        {recent.length ? (
          <ul className="m-0 list-none p-0">
            {recent.map((e) => (
              <EventRow key={e.id} e={e} compact />
            ))}
          </ul>
        ) : (
          <Empty>Os eventos aparecem aqui a cada luta (o save é gravado a cada ~15 s).</Empty>
        )}
      </Panel>
    </div>
  );
}

/**
 * The fight as it happens, split in two: our attacks on the left, the enemy's on the right, each
 * side with its own HP and its own counters.
 */
function LiveCombat({ snapshot, hp, maxHp }: { snapshot: AppSnapshot; hp: number; maxHp: number }) {
  const { live, save } = snapshot;
  const fight = live.fight;
  const session = live.session;
  const enemy = fight?.enemy ?? live.enemy;
  const running = live.status === 'live';

  return (
    <Panel
      title="Combate ao vivo"
      actions={
        fight ? (
          <Chip tone={live.inCombat ? 'up' : 'muted'}>{live.inCombat ? `turno ${fight.turns.at(-1)?.n ?? 0}` : fight.won === undefined ? 'parado' : fight.won ? 'vitória' : 'derrota'}</Chip>
        ) : undefined
      }
    >
      {!running ? (
        <Empty>Ligue o modo ao vivo (Alertas &amp; Ao vivo) para acompanhar turno a turno, com críticos e aparadas contados dos dois lados.</Empty>
      ) : !fight ? (
        <Empty>Esperando a próxima luta começar…</Empty>
      ) : (
        <>
          <CombatLog
            turns={fight.turns}
            youTally={fight.you}
            themTally={fight.them}
            you={{ name: save?.state.name || 'Você', sub: `nível ${snapshot.live.player?.level ?? save?.state.level ?? ''}`, hp, maxHp }}
            them={{
              name: enemy?.name ?? 'Inimigo',
              sub: enemy?.isPvP ? 'PvP' : enemy ? `nível ${enemy.level} · ${enemy.color}` : undefined,
              hp: enemy?.hp ?? 0,
              maxHp: enemy?.maxHp ?? 0,
              color: enemy && !enemy.isPvP ? ENEMY_COLOR_VAR(enemy.color) : undefined,
            }}
            empty="A luta começou; os turnos aparecem aqui."
            height={300}
          />
          {session && session.you.attacks > 0 && (
            <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface-2 p-2.5">
              <div className="text-[10px] tracking-[0.7px] text-muted uppercase">
                desde que o modo ao vivo ligou · {fmt(session.fights)} {session.fights === 1 ? 'luta' : 'lutas'} · {fmt(session.wins)} {session.wins === 1 ? 'vitória' : 'vitórias'}
              </div>
              <TallyRow t={session.you} parries={session.them.parried} tone="you" />
              <TallyRow t={session.them} parries={session.you.parried} tone="them" />
              <div className="text-[11px] text-muted">
                seus críticos {fmt1(session.you.landed ? (session.you.crits / session.you.landed) * 100 : 0)}% · você aparou{' '}
                {fmt1(session.them.attacks ? (session.them.parried / session.them.attacks) * 100 : 0)}% dos ataques deles
                {session.you.heal > 0 && ` · curou ${fmt(session.you.heal)} PV`}
                {session.them.counter > 0 && ` · levou ${fmt(session.them.counter)} de contra-ataque`}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** The line under the 10-minute figure: how many fights fed it, and how full the window is. */
function windowDetail(w: ReturnType<typeof xpWindow>): string {
  const fights = `${fmt(w.battles)} ${w.battles === 1 ? 'luta' : 'lutas'}`;
  if (!w.full) {
    const min = Math.floor(w.spanMs / 60_000);
    return `${fights} · contando há ${min < 1 ? 'menos de 1 min' : `${min} min`}`;
  }
  return w.perHour !== null ? `${fights} · ritmo de ${fmt(w.perHour)} XP/h` : fights;
}

/** The BotFarm `.par` card: icon + uppercase title, one big figure, one detail line. */
function RateCard({ icon, title, value, tone, detail }: { icon: string; title: string; value: string; tone: 'xp' | 'gold' | 'ink'; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-line-2 bg-bg-2 text-[15px]">{icon}</span>
        <span className="text-[11px] tracking-[0.8px] text-muted uppercase">{title}</span>
      </div>
      <div className={`num text-[22px] leading-tight font-semibold ${tone === 'xp' ? 'text-xp' : tone === 'gold' ? 'text-gold' : 'text-ink'}`}>{value}</div>
      <div className="text-[11px] text-muted">{detail}</div>
    </div>
  );
}
