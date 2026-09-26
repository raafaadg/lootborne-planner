import { Fragment, useEffect, useMemo, useState } from 'react';
import type { AppSnapshot, FightMode, GameEvent, PvpReplay, SaveState } from '@shared/contracts';
import {
  ARENA_NAME,
  MAX_GAP_MS,
  PVP_BOSSES,
  TRANSITION_MS,
  bossForecast,
  bossRecords,
  classifyBattles,
  pvpInterval,
  summarize,
  type BattleRow,
  type BossRecord,
  type ModeSummary,
  type PvpBoss,
} from '@shared/battles';
import { CATALOG_ITEMS, catalogItem, sector } from '../catalog';
import { TallyRow } from '../combat-log';
import { Icon } from '../icons';
import { Button, Chip, Empty, FilterChip, Grupo, Kpi, Panel, RarityName, ago, clock, cn, fmt, fmt1 } from '../ui';
import { NextBossKpi } from '../next-boss';
import { ReplayDetail } from './Pvp';

const KINDS = new Set<GameEvent['kind']>(['battle', 'drop', 'level_up', 'death', 'battle_paused', 'battle_resumed', 'autofight', 'sector_change']);
const HISTORY_LIMIT = 8_000;
const PAGE = 80;

type Period = 'session' | 'hour' | 'today' | 'all';
type ModeFilter = 'all' | 'pve' | 'arena' | 'pvp' | 'boss';
type ResultFilter = 'all' | 'won' | 'lost';

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'session', label: 'Sessão' },
  { id: 'hour', label: 'Última hora' },
  { id: 'today', label: 'Hoje' },
  { id: 'all', label: 'Tudo' },
];
const MODES: Array<{ id: ModeFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'pve', label: 'PvE' },
  { id: 'arena', label: 'Arena' },
  { id: 'pvp', label: 'PvP' },
  { id: 'boss', label: 'Bosses' },
];

export const MODE_LABEL: Record<FightMode, string> = { pve: 'PvE', arena: 'Arena', pvp: 'PvP', boss: 'Boss', friendly: 'Amistoso', other: 'Fora de luta' };
const MODE_TONE = { pve: 'muted', arena: 'accent', pvp: 'info', boss: 'warn', friendly: 'muted', other: 'muted' } as const;
const MODE_COLOR: Record<FightMode, string> = { pve: '#8a7f6a', arena: 'var(--color-accent)', pvp: 'var(--color-xp)', boss: 'var(--color-gold)', friendly: '#6b6252', other: '#4a4234' };
const MODE_FROM: Record<BattleRow['modeFrom'], string> = {
  live: 'visto ao vivo',
  save: 'pelo save (o PvE avança o setor, o PvP não)',
  replay: 'pelo replay que o jogo gravou no mesmo segundo',
  xp: 'pelo XP: um boss paga sempre o mesmo valor',
  guess: 'suposição: luta sem o ao vivo, antes do Planner registrar o tipo',
};

/** 22,7 s · 1min 05s · 2h 05min; `approx` marks the ones estimated from the saves. */
export function dur(ms: number | null | undefined, approx = false): string {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  const text =
    s < 60
      ? `${fmt1(s)} s`
      : s < 3600
        ? `${Math.floor(s / 60)}min ${String(Math.round(s % 60)).padStart(2, '0')}s`
        : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}min`;
  return approx ? `≈${text}` : text;
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The history on disk plus whatever the snapshot brought since, and every PvP replay in the archive. */
function useBattleRows(snapshot: AppSnapshot): { rows: BattleRow[]; loading: boolean } {
  const [history, setHistory] = useState<GameEvent[] | null>(null);
  const [replays, setReplays] = useState<PvpReplay[] | null>(null);
  const newestReplay = snapshot.pvp[0]?.file ?? '';

  useEffect(() => {
    let alive = true;
    void window.planner
      .battleHistory(HISTORY_LIMIT)
      .then((list) => alive && setHistory(list))
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.planner
      .pvpHistory()
      .then((list) => alive && setReplays(list))
      .catch(() => alive && setReplays([]));
    return () => {
      alive = false;
    };
  }, [newestReplay]);

  const events = useMemo(() => {
    const base = history ?? [];
    const ids = new Set(base.map((e) => e.id));
    const fresh = snapshot.events.filter((e) => KINDS.has(e.kind) && !ids.has(e.id));
    return [...base, ...fresh].sort((a, b) => a.t.localeCompare(b.t));
  }, [history, snapshot.events]);

  const allReplays = replays ?? snapshot.pvp;
  const rows = useMemo(() => classifyBattles(events, allReplays), [events, allReplays]);
  return { rows, loading: history === null };
}

export function BattlesPage({ snapshot, now }: { snapshot: AppSnapshot; now: number }) {
  const { rows, loading } = useBattleRows(snapshot);
  const [period, setPeriod] = useState<Period>('today');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [result, setResult] = useState<ResultFilter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const state = snapshot.save?.state ?? null;

  // `now` ticks every second; the last hour moves by the minute so the lists are not rebuilt each tick
  const since =
    period === 'session'
      ? Date.parse(snapshot.stats.startedAt)
      : period === 'hour'
        ? Math.floor(now / 60_000) * 60_000 - 3_600_000
        : period === 'today'
          ? startOfToday(now)
          : 0;
  const inPeriod = useMemo(() => rows.filter((r) => Date.parse(r.t) >= since), [rows, since]);
  const selected = useMemo(
    () => inPeriod.filter((r) => mode === 'all' || r.mode === mode || (mode === 'pvp' && r.mode === 'friendly')),
    [inPeriod, mode],
  );
  const list = useMemo(
    () => selected.filter((r) => result === 'all' || (result === 'won' ? r.won === true : r.won === false)).reverse(),
    [selected, result],
  );

  const total = useMemo(() => summarize(selected, 'all'), [selected]);
  const byMode = useMemo(
    () => (['pve', 'arena', 'pvp', 'boss', 'friendly'] as const).map((m) => summarize(inPeriod, m)).filter((s) => s.fights > 0),
    [inPeriod],
  );
  const rhythm = useMemo(() => loopRhythm(selected), [selected]);
  const records = useMemo(() => bossRecords(rows, state), [rows, state]);
  const forecast = bossForecast(state);
  const interval = useMemo(() => pvpInterval(rows), [rows]);

  if (!rows.length) {
    return <Empty>{loading ? 'Carregando o histórico de lutas…' : 'Nenhuma luta registrada ainda. Elas aparecem aqui assim que o save é regravado.'}</Empty>;
  }

  return (
    <div className="flex flex-col gap-3">
      <LiveStrip snapshot={snapshot} now={now} />

      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODS.map((p) => (
          <FilterChip key={p.id} on={period === p.id} onClick={() => setPeriod(p.id)}>
            {p.label}
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        {MODES.map((m) => (
          <FilterChip key={m.id} on={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </FilterChip>
        ))}
        {loading && <span className="ml-auto text-[11px] text-muted">carregando o histórico…</span>}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
        <Kpi
          icon="⚔️"
          value={fmt(total.fights)}
          label="lutas"
          sub={total.fights ? `${fmt(total.wins)} V · ${fmt(total.losses)} D · ${pct(total.winRate)} de vitórias` : undefined}
          tone="gold"
        />
        <Kpi
          icon="⏱️"
          value={dur(total.duration.avgMs, total.duration.timed < total.duration.n)}
          label="tempo médio por luta"
          sub={total.duration.n ? `mediana ${dur(total.duration.medianMs)} · ${durationSource(total)}` : 'sem tempos neste período'}
          title={`Com o ao vivo ligado cada luta é cronometrada do início ao fim. Sem ele, o tempo sai do intervalo entre dois saves menos os ~${fmt1(TRANSITION_MS / 1000)} s de transição entre as lutas.`}
        />
        <Kpi
          icon="⌛"
          value={dur(total.duration.totalMs)}
          label="tempo em luta"
          sub={rhythm.fightsPerHour ? `${fmt(rhythm.fightsPerHour)} lutas/h com o loop rodando` : undefined}
        />
        <Kpi
          icon="✨"
          value={total.xpPerFightMinute ? fmt(total.xpPerFightMinute) : '—'}
          label="XP por minuto de luta"
          sub={total.avgXp !== null ? `XP médio ${fmt(total.avgXp)} por luta` : undefined}
          tone="xp"
        />
        <NextBossKpi state={state} interval={interval} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.35fr_1fr]">
        <Panel title="Por tipo de luta" actions={<span className="text-[11px] text-muted">{PERIODS.find((p) => p.id === period)?.label.toLowerCase()}</span>}>
          <ModeTable rows={byMode} />
          <p className="m-0 text-[11px] leading-snug text-muted">
            O loop do jogo mistura as lutas do setor com uma partida de PvP a cada {interval ? `~${Math.round(interval / 60_000)} min` : 'poucos minutos'}; a cada 10 partidas de PvP a
            próxima é um <b className="text-gold">boss de PvP</b>. Nenhum dos dois mexe no seu HP nem no avanço do setor, e o boss não deixa replay.
          </p>
        </Panel>
        <Panel title="Duração das lutas" actions={<span className="text-[11px] text-muted">faixas de 5 s</span>}>
          <DurationHistogram rows={selected} />
        </Panel>
      </div>

      <Grupo nota="BossPvpEncounter: um boss por faixa de nível, até você ter o item que ele dá">Bosses de PvP</Grupo>
      <BossGrid records={records} state={state} forecast={forecast} />

      <Panel
        title="Lutas"
        actions={
          <span className="flex items-center gap-1.5">
            {(['won', 'lost'] as const).map((r) => (
              <FilterChip key={r} on={result === r} onClick={() => setResult(result === r ? 'all' : r)}>
                {r === 'won' ? 'vitórias' : 'derrotas'}
              </FilterChip>
            ))}
            <span className="text-[11px] text-muted">{fmt(list.length)} lutas</span>
          </span>
        }
      >
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[10px] tracking-[0.6px] text-muted uppercase">
                  <th className="py-1.5 pr-2 font-semibold">hora</th>
                  <th className="py-1.5 pr-2 font-semibold">tipo</th>
                  <th className="py-1.5 pr-2 font-semibold">inimigo</th>
                  <th className="py-1.5 pr-2 font-semibold">resultado</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">duração</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">XP</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">HP</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">ataques</th>
                  <th className="py-1.5 font-semibold">drop</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, limit).map((r) => (
                  <Fragment key={r.id}>
                    <FightRow r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                    {open === r.id && (
                      <tr>
                        <td colSpan={9} className="border-b border-row bg-bg-2 p-3">
                          <FightDetail r={r} snapshot={snapshot} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nenhuma luta com esses filtros.</Empty>
        )}
        {list.length > limit && (
          <Button mini onClick={() => setLimit(limit + PAGE * 2)}>
            mostrar mais ({fmt(list.length - limit)})
          </Button>
        )}
      </Panel>
    </div>
  );
}

function durationSource(s: ModeSummary): string {
  const { n, timed } = s.duration;
  if (timed === n) return 'todas cronometradas ao vivo';
  if (timed === 0) return 'estimado pelos saves';
  return `${fmt(timed)} de ${fmt(n)} cronometradas ao vivo`;
}

/** Fights per hour over the time the loop was actually running (gaps short enough to be one run). */
function loopRhythm(rows: BattleRow[]): { fightsPerHour: number | null } {
  let active = 0;
  let counted = 0;
  for (let i = 1; i < rows.length; i++) {
    const g = Date.parse(rows[i]!.t) - Date.parse(rows[i - 1]!.t);
    if (g > 0 && g <= MAX_GAP_MS) {
      active += g;
      counted++;
    }
  }
  return { fightsPerHour: active > 10 * 60_000 ? Math.round(counted / (active / 3_600_000)) : null };
}

function LiveStrip({ snapshot, now }: { snapshot: AppSnapshot; now: number }) {
  const { live } = snapshot;
  const fight = live.fight;
  if (live.status !== 'live' || !live.inCombat || !fight || fight.endedAt) return null;
  const e = fight.enemy;
  const boss = PVP_BOSSES.find((b) => b.name === e?.name);
  const kind: FightMode = boss || e?.isBossPvp ? 'boss' : e?.isFriendly ? 'friendly' : e?.isPvP ? 'pvp' : e?.isArenaBoss || ARENA_NAME.test(e?.name ?? '') ? 'arena' : 'pve';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-card border border-[#4a3512] bg-[#221a0c] px-3 py-2 text-[13px]">
      <span className="h-2 w-2 animate-pulsa rounded-full bg-gold" />
      <span className="text-muted">lutando agora</span>
      <Chip tone={MODE_TONE[kind]}>{MODE_LABEL[kind]}</Chip>
      <b className="text-ink">{e?.name ?? 'inimigo'}</b>
      {e && <span className="text-muted">nv {e.level}</span>}
      <span className="num ml-auto text-gold">{dur(now - Date.parse(fight.startedAt))}</span>
      <span className="num text-muted">{fmt(fight.you.attacks + fight.them.attacks)} ataques</span>
    </div>
  );
}

function ModeTable({ rows }: { rows: ModeSummary[] }) {
  if (!rows.length) return <Empty>Nenhuma luta neste período.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[10px] tracking-[0.6px] text-muted uppercase">
            <th className="py-1.5 pr-2 font-semibold">tipo</th>
            <th className="py-1.5 pr-2 text-right font-semibold">lutas</th>
            <th className="py-1.5 pr-2 text-right font-semibold">V / D</th>
            <th className="py-1.5 pr-2 text-right font-semibold">vitórias</th>
            <th className="py-1.5 pr-2 text-right font-semibold" title="média · mediana">tempo médio</th>
            <th className="py-1.5 pr-2 text-right font-semibold">mais curta</th>
            <th className="py-1.5 pr-2 text-right font-semibold">mais longa</th>
            <th className="py-1.5 pr-2 text-right font-semibold">XP médio</th>
            <th className="py-1.5 text-right font-semibold">XP/min</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const approx = s.duration.timed < s.duration.n;
            return (
              <tr key={s.mode} className="border-t border-row">
                <td className="py-1.5 pr-2">
                  <Chip tone={MODE_TONE[s.mode]}>{MODE_LABEL[s.mode]}</Chip>
                </td>
                <td className="num py-1.5 pr-2 text-right">{fmt(s.fights)}</td>
                <td className="num py-1.5 pr-2 text-right">
                  <span className="text-up">{fmt(s.wins)}</span> / <span className="text-down">{fmt(s.losses)}</span>
                </td>
                <td className={cn('num py-1.5 pr-2 text-right font-semibold', (s.winRate ?? 1) < 0.5 ? 'text-down' : 'text-up')}>{pct(s.winRate)}</td>
                <td className="num py-1.5 pr-2 text-right" title={durationSource(s)}>
                  {dur(s.duration.avgMs, approx)} <span className="text-muted">· {dur(s.duration.medianMs)}</span>
                </td>
                <td className="num py-1.5 pr-2 text-right text-muted">{dur(s.duration.minMs)}</td>
                <td className="num py-1.5 pr-2 text-right text-muted">{dur(s.duration.maxMs)}</td>
                <td className="num py-1.5 pr-2 text-right text-xp">{s.avgXp !== null ? fmt(s.avgXp) : '—'}</td>
                <td className="num py-1.5 text-right text-xp">{s.xpPerFightMinute ? fmt(s.xpPerFightMinute) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const BIN_S = 5;
const BINS = 13; // 0–60 s and a last "60 s +" bin

function DurationHistogram({ rows }: { rows: BattleRow[] }) {
  const modes: FightMode[] = ['pve', 'arena', 'pvp', 'boss', 'friendly'];
  const bins = Array.from({ length: BINS }, () => ({ pve: 0, arena: 0, pvp: 0, boss: 0, friendly: 0, other: 0 }) as Record<FightMode, number>);
  for (const r of rows) {
    if (r.durationMs === null || r.mode === 'other') continue;
    const i = Math.min(BINS - 1, Math.floor(r.durationMs / 1000 / BIN_S));
    bins[i]![r.mode]++;
  }
  const max = Math.max(1, ...bins.map((b) => modes.reduce((a, m) => a + b[m], 0)));
  const present = modes.filter((m) => bins.some((b) => b[m] > 0));
  if (!present.length) return <Empty>Sem tempos neste período.</Empty>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-[132px] items-end gap-[3px]">
        {bins.map((b, i) => {
          const n = modes.reduce((a, m) => a + b[m], 0);
          const label = i === BINS - 1 ? `${(BINS - 1) * BIN_S} s ou mais` : `${i * BIN_S}–${(i + 1) * BIN_S} s`;
          return (
            <div
              key={i}
              className="flex h-full min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-t-[3px] bg-bg-2"
              title={`${label}: ${n} lutas${present.length > 1 ? ` (${present.map((m) => `${MODE_LABEL[m]} ${b[m]}`).join(', ')})` : ''}`}
            >
              {modes.map((m) => (b[m] ? <i key={m} className="block w-full" style={{ height: `${(b[m] / max) * 100}%`, background: MODE_COLOR[m] }} /> : null))}
            </div>
          );
        })}
      </div>
      <div className="flex gap-[3px] text-center text-[9px] text-muted">
        {bins.map((_, i) => (
          <span key={i} className="num min-w-0 flex-1">
            {i === BINS - 1 ? '60+' : i % 2 === 0 ? i * BIN_S : ''}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        {present.map((m) => (
          <span key={m} className="flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: MODE_COLOR[m] }} />
            {MODE_LABEL[m]}
          </span>
        ))}
        <span className="ml-auto">segundos</span>
      </div>
    </div>
  );
}

// ---- bosses -----------------------------------------------------------------------------------

function weaponElements(state: SaveState | null): string[] {
  if (!state) return [];
  const equipped = new Set(state.equippedUids);
  return state.inventory
    .filter((i) => equipped.has(i.uid) && i.slot === 3)
    .map((i) => catalogItem(i.templateId)?.element)
    .filter((e): e is NonNullable<typeof e> => Boolean(e) && e !== 'Nessuna');
}

function BossGrid({ records, state, forecast }: { records: BossRecord[]; state: SaveState | null; forecast: ReturnType<typeof bossForecast> }) {
  const weapons = weaponElements(state);
  return (
    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 2xl:grid-cols-4">
      {records.map((r) => (
        <BossCard key={r.boss.index} r={r} current={forecast?.boss?.index === r.boss.index} level={state?.level ?? 0} weapons={weapons} />
      ))}
    </div>
  );
}

function bossStatus(r: BossRecord, current: boolean, level: number): { label: string; tone: 'up' | 'warn' | 'muted' | 'down' } {
  if (r.defeated) return { label: 'derrotado', tone: 'up' };
  if (current) return { label: 'aparece agora', tone: 'warn' };
  if (level < r.boss.level) return { label: `a partir do nv ${r.boss.level}`, tone: 'muted' };
  return { label: 'faixa passou', tone: 'muted' };
}

function BossCard({ r, current, level, weapons }: { r: BossRecord; current: boolean; level: number; weapons: string[] }) {
  const b = r.boss;
  const status = bossStatus(r, current, level);
  const drop = CATALOG_ITEMS.find((i) => i.id === b.dropId);
  const resisted = b.resist && weapons.includes(b.resist);
  const weakHit = b.weak && weapons.includes(b.weak);
  return (
    <section className={cn('flex min-w-0 flex-col gap-2 rounded-card border bg-surface px-3 py-2.5', current ? 'border-gold' : 'border-line')}>
      <div className="flex items-baseline gap-2">
        <b className={cn('truncate text-[14px]', current ? 'text-gold' : 'text-ink')}>{b.name}</b>
        <span className="text-[11px] text-muted">nv {b.level}</span>
        <span className="ml-auto">
          <Chip tone={status.tone}>{status.label}</Chip>
        </span>
      </div>
      <BossStats boss={b} />
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Chip>{b.element}</Chip>
        {b.resist && (
          <Chip tone={resisted ? 'down' : 'muted'} title={resisted ? 'sua arma é deste elemento: o boss resiste ao seu dano' : undefined}>
            resiste {b.resist}
          </Chip>
        )}
        {b.weak && (
          <Chip tone={weakHit ? 'up' : 'muted'} title={weakHit ? 'sua arma é deste elemento: o boss é fraco a ele' : undefined}>
            fraco a {b.weak}
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        <Icon family="items" id={b.dropId} scale={1} />
        <span className="min-w-0 truncate">
          {drop ? <RarityName rarity={drop.rarity}>{drop.name}</RarityName> : b.drop}
          <span className="text-muted"> · {drop?.rarity}</span>
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 border-t border-row pt-2 text-center text-[11px]">
        <div>
          <div className="num text-[14px] font-semibold">
            <span className="text-up">{r.wins}</span>
            <span className="text-muted"> / </span>
            <span className={r.losses ? 'text-down' : 'text-muted'}>{r.losses}</span>
          </div>
          <div className="text-[9px] tracking-[0.5px] text-muted uppercase">V / D</div>
        </div>
        <div>
          <div className="num text-[14px] font-semibold text-xp">
            {b.xpWin} <span className="text-muted">/</span> {b.xpLose}
          </div>
          <div className="text-[9px] tracking-[0.5px] text-muted uppercase">XP ganha / perde</div>
        </div>
        <div>
          <div className="num text-[14px] font-semibold">{r.avgDurationMs ? dur(r.avgDurationMs) : '—'}</div>
          <div className="text-[9px] tracking-[0.5px] text-muted uppercase">{r.lastAt ? `última há ${ago(r.lastAt)}` : 'nunca visto'}</div>
        </div>
      </div>
      {current && !r.defeated && (
        <p className="m-0 text-[11px] leading-snug text-muted">
          Volta a cada 10 lutas de PvP até você ter <b className="text-ink">{b.drop}</b>.
          {resisted ? <span className="text-down"> Sua arma de {b.resist} é resistida por ele.</span> : null}
          {b.weak && !weakHit ? <span> Uma arma de {b.weak} bate mais forte.</span> : null}
        </p>
      )}
    </section>
  );
}

function BossStats({ boss }: { boss: PvpBoss }) {
  const s = boss.stats;
  const cells: Array<[string, string]> = [
    ['HP', fmt(s.hp)],
    ['ATK', fmt1(s.atk)],
    ['DEF', fmt1(s.def)],
    ['CRIT', `${fmt1(s.crit)}%`],
    ['PARRY', `${fmt1(s.parry)}%`],
  ];
  return (
    <div className="grid grid-cols-5 gap-1 text-center">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-md border border-line bg-bg-2 px-0.5 py-1">
          <div className="num text-[12px] leading-none font-semibold">{v}</div>
          <div className="mt-0.5 text-[8px] tracking-[0.5px] text-muted">{k}</div>
        </div>
      ))}
    </div>
  );
}

// ---- the list ---------------------------------------------------------------------------------

function enemyLabel(r: BattleRow) {
  if (r.mode === 'other') return <span className="text-muted">XP creditado ao voltar ao jogo</span>;
  if (r.enemy) {
    const color = (r.mode === 'pve' || r.mode === 'arena') && r.enemyColor ? `var(--color-enemy-${['Grigio', 'Blu', 'Viola'].indexOf(r.enemyColor)})` : r.mode === 'boss' ? 'var(--color-gold)' : undefined;
    return (
      <>
        <b style={{ color }}>{r.enemy}</b>
        {r.enemyLevel !== null && <span className="text-muted"> nv {r.enemyLevel}</span>}
      </>
    );
  }
  if (r.mode === 'pvp') return <span className="text-muted">adversário sem replay</span>;
  return (
    <span className="text-muted" title="luta sem o ao vivo: o save não guarda o nome do inimigo">
      inimigo {r.enemyIndex} · {sector(r.sector)?.name ?? `setor ${r.sector}`}
    </span>
  );
}

function FightRow({ r, open, onToggle }: { r: BattleRow; open: boolean; onToggle: () => void }) {
  const approx = r.durationFrom === 'gap';
  return (
    <tr onClick={onToggle} className={cn('cursor-pointer border-t border-row hover:bg-surface-2', open && 'bg-surface-2')}>
      <td className="num py-1.5 pr-2 text-xs whitespace-nowrap text-muted">{clock(r.t)}</td>
      <td className="py-1.5 pr-2">
        <Chip tone={MODE_TONE[r.mode]} title={MODE_FROM[r.modeFrom]}>
          {MODE_LABEL[r.mode]}
          {r.modeFrom === 'guess' || r.modeFrom === 'xp' ? '?' : ''}
        </Chip>
      </td>
      <td className="max-w-[260px] truncate py-1.5 pr-2">{enemyLabel(r)}</td>
      <td className="py-1.5 pr-2">
        {r.won === null ? <span className="text-muted">—</span> : <Chip tone={r.won ? 'up' : 'down'}>{r.won ? 'vitória' : r.died ? 'morte' : 'derrota'}</Chip>}
      </td>
      <td
        className={cn('num py-1.5 pr-2 text-right whitespace-nowrap', approx && 'text-muted')}
        title={r.durationFrom === 'live' ? 'cronometrada ao vivo' : approx ? `estimada: intervalo entre saves menos ~${fmt1(TRANSITION_MS / 1000)} s de transição` : undefined}
      >
        {dur(r.durationMs, approx)}
      </td>
      <td className="num py-1.5 pr-2 text-right whitespace-nowrap text-xp">{r.xp ? `+${fmt(r.xp)}` : '0'}</td>
      <td className="num py-1.5 pr-2 text-right whitespace-nowrap text-muted">{r.mode === 'pve' || r.mode === 'arena' ? `${fmt(r.hp[0])}→${fmt(r.hp[1])}` : '—'}</td>
      <td className="num py-1.5 pr-2 text-right text-muted">{r.turns ?? '—'}</td>
      <td className="max-w-[200px] truncate py-1.5">
        {r.drops.map((d, i) => (
          <span key={`${d.uid}-${i}`}>
            {i > 0 && ', '}
            <RarityName rarity={d.rarity}>{d.name}</RarityName>
          </span>
        ))}
        {r.levelUp && <Chip tone="accent">nível {r.levelUp}</Chip>}
      </td>
    </tr>
  );
}

function FightDetail({ r, snapshot }: { r: BattleRow; snapshot: AppSnapshot }) {
  const secs = r.durationMs ? r.durationMs / 1000 : null;
  const stamina = Math.round((r.stamina[0] - r.stamina[1]) * 100) / 100;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2">
        <Box label="duração" value={dur(r.durationMs, r.durationFrom === 'gap')} hint={r.durationFrom === 'live' ? 'cronometrada ao vivo' : r.durationFrom === 'gap' ? 'estimada pelos saves' : 'sem tempo'} />
        <Box label="XP" value={`+${fmt(r.xp)}`} hint={secs ? `${fmt((r.xp / secs) * 60)} XP/min` : undefined} tone="xp" />
        {(r.mode === 'pve' || r.mode === 'arena') && <Box label="HP" value={`${fmt(r.hp[0])} → ${fmt(r.hp[1])}`} hint={`${r.hp[1] - r.hp[0] >= 0 ? '+' : ''}${fmt(r.hp[1] - r.hp[0])}`} />}
        {r.mode === 'arena' && r.wave !== undefined && <Box label="arena" value={`onda ${r.wave}`} hint={r.arenaBoss ? 'o boss da onda' : `luta ${r.waveKill ?? '?'} de 10`} />}
        {stamina > 0 && <Box label="stamina" value={`−${fmt1(stamina)}`} hint={`sobrou ${fmt1(r.stamina[1])}`} />}
        {r.turns !== null && <Box label="ataques" value={fmt(r.turns)} hint={secs ? `${fmt1(r.turns / secs)} por segundo` : undefined} />}
        {r.mode === 'pve' && <Box label="setor" value={sector(r.sector)?.name ?? String(r.sector)} hint={`inimigo ${r.enemyIndex} · pity ${r.pity}`} />}
        {r.rpDelta !== undefined && <Box label="ranking" value={`${r.rpDelta > 0 ? '+' : ''}${fmt(r.rpDelta)}`} />}
      </div>

      {r.you && r.them && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-[12px]">
              <b className="text-gold">você</b>
              {secs && <span className="num text-muted">{fmt1(r.you.damage / secs)} dano/s</span>}
            </div>
            <TallyRow t={r.you} parries={r.them.parried} tone="you" />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-[12px]">
              <b className="text-down">{r.enemy ?? 'inimigo'}</b>
              {secs && <span className="num text-muted">{fmt1(r.them.damage / secs)} dano/s</span>}
            </div>
            <TallyRow t={r.them} parries={r.you.parried} tone="them" />
          </div>
        </div>
      )}

      {r.enemyStats && (
        <div className="text-[12px] text-muted">
          {r.enemy ?? 'Inimigo'}: HP <b className="num text-ink">{fmt(r.enemyStats.hp)}</b> · ATK <b className="num text-ink">{fmt1(r.enemyStats.atk)}</b> · DEF{' '}
          <b className="num text-ink">{fmt1(r.enemyStats.def)}</b> · CRIT <b className="num text-ink">{fmt1(r.enemyStats.crit)}%</b> · PARRY{' '}
          <b className="num text-ink">{fmt1(r.enemyStats.parry)}%</b>
          {r.modeFrom !== 'live' && r.boss ? ' (a ficha do boss)' : ''}
        </div>
      )}

      {r.boss && !r.you && <p className="m-0 text-[12px] text-muted">O boss não deixa replay: com o ao vivo ligado esta luta mostra golpes, críticos e dano de cada lado.</p>}
      {!r.you && !r.replay && r.mode !== 'boss' && r.mode !== 'other' && (
        <p className="m-0 text-[12px] text-muted">Os detalhes golpe a golpe só existem para as lutas vistas com o ao vivo ligado (ou no replay, no PvP).</p>
      )}
      <p className="m-0 text-[11px] text-muted">Tipo identificado {MODE_FROM[r.modeFrom]}.</p>

      {r.replay && <ReplayDetail summary={r.replay} snapshot={snapshot} />}
    </div>
  );
}

function Box({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'xp' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2">
      <span className="text-[10px] tracking-[0.7px] text-muted uppercase">{label}</span>
      <span className={cn('num truncate text-[15px] leading-tight font-semibold', tone === 'xp' ? 'text-xp' : 'text-ink')}>{value}</span>
      {hint && <span className="truncate text-[11px] text-muted">{hint}</span>}
    </div>
  );
}
