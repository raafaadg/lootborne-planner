import { useEffect, useMemo, useState } from 'react';
import type { AppSnapshot, PvpFighter, PvpReplay, PvpScouted, SideTally } from '@shared/contracts';
import { analyzeReplay, opponentRecords, type Measured, type ReplayAnalysis, type SideAnalysis } from '@shared/pvp-analysis';
import { powerScore } from '@shared/game-math';
import { CATALOG_ITEMS, PERKS } from '../catalog';
import { CombatLog } from '../combat-log';
import { Icon } from '../icons';
import { Bar, Button, Chip, Empty, FilterChip, Grupo, Kpi, Panel, cn, clock, fmt, fmt1, rarityColor } from '../ui';

const BY_NAME = new Map(CATALOG_ITEMS.map((i) => [i.name, i]));
const SLOT_ORDER = ['Testa', 'Corpo', 'Cintura', 'Arma 1', 'Arma 2', 'Anello 1', 'Anello 2', 'Trinket'];

type Mode = 'todos' | 'ranqueado' | 'amistoso';
type Result = 'todos' | 'v' | 'd';

export function PvpPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [history, setHistory] = useState<PvpReplay[] | null>(null);
  const [mode, setMode] = useState<Mode>('todos');
  const [result, setResult] = useState<Result>('todos');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const newest = snapshot.pvp[0]?.file ?? '';

  // The snapshot only carries the recent fights; the archive has all of them.
  useEffect(() => {
    let alive = true;
    void window.planner
      .pvpHistory()
      .then((list) => alive && setHistory(list))
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [newest]);

  const all = history ?? snapshot.pvp;
  const ranked = all.filter((r) => !r.friendly);
  const wins = ranked.filter((r) => r.won).length;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (r) =>
        (mode === 'todos' || (mode === 'amistoso') === r.friendly) &&
        (result === 'todos' || (result === 'v') === r.won) &&
        (!q || r.opponent.name.toLowerCase().includes(q)),
    );
  }, [all, mode, result, query]);

  const current = list.find((r) => r.file === selected) ?? list[0] ?? null;
  const records = useMemo(() => opponentRecords(all), [all]);

  if (!all.length) {
    return <Empty>{history === null ? 'Carregando o histórico…' : 'Nenhuma luta de PvP ainda (o jogo faz as lutas sozinho em segundo plano).'}</Empty>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-2.5">
        <Kpi icon="🏆" value={`${fmt(wins)}/${fmt(ranked.length)}`} label="vitórias no ranqueado" tone="good" sub={ranked.length ? `${Math.round((wins / ranked.length) * 100)}% de vitórias` : undefined} />
        <Kpi icon="📚" value={fmt(all.length)} label="lutas guardadas" sub={all.length > 15 ? 'o jogo só guarda 15' : 'arquivadas aqui'} />
        <Kpi icon="🩸" value={fmt(snapshot.save?.state.pvpCurrency)} label="bloodmarks" tone="gold" />
        <Kpi icon="👥" value={fmt(records.length)} label="adversários diferentes" />
        <Kpi icon="⏱️" value={fmt(Math.round(all.reduce((a, r) => a + r.turns, 0) / all.length))} label="turnos por luta" />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(280px,0.8fr)_1.6fr]">
        <Panel title="Histórico" actions={<span className="text-[11px] text-muted">{fmt(list.length)} lutas</span>}>
          <div className="flex flex-wrap gap-1.5">
            {(['todos', 'ranqueado', 'amistoso'] as Mode[]).map((m) => (
              <FilterChip key={m} on={mode === m} onClick={() => setMode(m)}>
                {m}
              </FilterChip>
            ))}
            {(['v', 'd'] as Result[]).map((r) => (
              <FilterChip key={r} on={result === r} onClick={() => setResult(result === r ? 'todos' : r)}>
                {r === 'v' ? 'vitórias' : 'derrotas'}
              </FilterChip>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="procurar adversário…"
            className="w-full rounded-lg border border-line bg-bg-2 px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          <ul className="m-0 flex max-h-[560px] list-none flex-col overflow-y-auto p-0">
            {list.slice(0, limit).map((r) => (
              <li key={r.file}>
                <button
                  type="button"
                  onClick={() => setSelected(r.file)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-[13px] text-ink',
                    current?.file === r.file ? 'border-line-2 bg-surface-2' : 'border-transparent bg-transparent hover:bg-surface-2',
                  )}
                >
                  <Chip tone={r.won ? 'up' : 'down'}>{r.won ? 'V' : 'D'}</Chip>
                  <span className="min-w-0 flex-1 truncate">
                    {r.opponent.name} <span className="text-muted">nv {r.opponent.level}</span>
                  </span>
                  {r.friendly && <Chip>amistoso</Chip>}
                  {r.suddenDeath && <Chip tone="warn">morte súbita</Chip>}
                  <span className="num shrink-0 text-xs text-muted">{new Date(r.t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                </button>
              </li>
            ))}
          </ul>
          {list.length > limit && (
            <Button mini onClick={() => setLimit(limit + 100)}>
              mostrar mais ({fmt(list.length - limit)})
            </Button>
          )}
        </Panel>

        {current ? <ReplayDetail summary={current} snapshot={snapshot} /> : <Empty>Nenhuma luta com esses filtros.</Empty>}
      </div>

      <Grupo nota="tudo que já passou por aqui, mesmo as lutas que o jogo já apagou">Adversários</Grupo>
      <Panel>
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[10px] tracking-[0.6px] text-muted uppercase">
                <th className="py-1.5 pr-2">adversário</th>
                <th className="py-1.5 pr-2">nível</th>
                <th className="py-1.5 pr-2">HP</th>
                <th className="py-1.5 pr-2">lutas</th>
                <th className="py-1.5 pr-2">retrospecto</th>
                <th className="py-1.5">última</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.name} className="border-t border-row">
                  <td className="py-1.5 pr-2">
                    <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-left text-ink hover:text-gold" onClick={() => setQuery(r.name)}>
                      {r.name}
                    </button>
                  </td>
                  <td className="num py-1.5 pr-2 text-muted">{r.lastLevel}</td>
                  <td className="num py-1.5 pr-2 text-muted">{fmt(r.maxHp)}</td>
                  <td className="num py-1.5 pr-2">{r.fights}</td>
                  <td className="py-1.5 pr-2">
                    <span className="num text-up">{r.wins}V</span> <span className="num text-down">{r.losses}D</span>
                  </td>
                  <td className="num py-1.5 text-muted">{new Date(r.lastAt).toLocaleDateString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export function ReplayDetail({ summary, snapshot }: { summary: PvpReplay; snapshot: AppSnapshot }) {
  const [detail, setDetail] = useState<PvpReplay | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    void window.planner
      .pvpDetail(summary.file)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null));
    return () => {
      alive = false;
    };
  }, [summary.file]);

  const state = snapshot.save?.state;
  const analysis = useMemo(() => {
    if (!detail?.log) return null;
    return analyzeReplay(detail.player, detail.opponent, detail.log, {
      byName: BY_NAME,
      allocation: state
        ? { hp: state.allocatedHp, atk: state.allocatedAtk, def: state.allocatedDef, crit: state.allocatedCrit, parry: state.allocatedParry }
        : undefined,
      playerStats: snapshot.combat.stats,
      playerPerks: snapshot.combat.perkMods as { atkPct?: number; defPct?: number; atkFlat?: number; critFlat?: number } | undefined,
    });
  }, [detail, state, snapshot.combat.stats]);

  const r = detail ?? summary;
  const scouted = snapshot.pvpScouts[r.opponent.name];
  // ours are the ones equipped right now; replays keep no perk record at all
  const myPerks = (snapshot.save?.state.equippedPerkIds ?? []).filter((id) => id > 0);

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title={
          <span>
            {r.won ? 'Vitória' : 'Derrota'} contra <span className="text-gold">{r.opponent.name}</span>
          </span>
        }
        actions={
          <span className="flex items-center gap-1.5">
            {r.friendly && <Chip>amistoso</Chip>}
            {r.suddenDeath && <Chip tone="warn">morte súbita</Chip>}
            <span className="text-[11px] text-muted">{new Date(r.t).toLocaleString('pt-BR')}</span>
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <FighterCard f={r.player} tally={r.you} side="you" analysis={analysis?.you} perkIds={myPerks} />
          <FighterCard f={r.opponent} tally={r.them} side="them" analysis={analysis?.them} scouted={scouted} perkIds={scouted?.perkIds} />
        </div>
      </Panel>

      {analysis && <Comparison a={analysis} scouted={scouted} />}

      {detail?.log ? (
        <Panel title="Turno a turno">
          <HpChart r={detail} />
          <CombatLog
            turns={detail.log.map((t, i) => ({ ...t, n: i + 1, playerHp: t.hpPlayer, enemyHp: t.hpEnemy }))}
            you={{ name: detail.player.name, sub: `nível ${detail.player.level}`, hp: detail.log.at(-1)?.hpPlayer ?? 0, maxHp: detail.player.maxHp }}
            them={{ name: detail.opponent.name, sub: `nível ${detail.opponent.level}`, hp: detail.log.at(-1)?.hpEnemy ?? 0, maxHp: detail.opponent.maxHp }}
            youTally={detail.you}
            themTally={detail.them}
            height={360}
          />
        </Panel>
      ) : (
        <Panel title="Turno a turno">
          <Empty>Carregando o replay…</Empty>
        </Panel>
      )}
    </div>
  );
}

function FighterCard({
  f,
  tally,
  side,
  analysis,
  scouted,
  perkIds,
}: {
  f: PvpFighter;
  tally: SideTally;
  side: 'you' | 'them';
  analysis?: SideAnalysis;
  scouted?: PvpScouted;
  /** our own loadout from the save; for the opponent it only exists when the tap scouted them */
  perkIds?: number[];
}) {
  const gear = [...f.gear].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  // the game's own numbers beat anything we infer
  const exact = scouted ? { hp: scouted.maxHp, atk: scouted.atk, def: scouted.def, crit: scouted.crit, parry: scouted.parry } : null;
  const power = exact ? powerScore(exact) : analysis?.power;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-bg-2 p-3">
      <div className="flex items-center gap-2">
        <span className={cn('truncate text-[15px] font-semibold', side === 'you' ? 'text-gold' : 'text-ink')}>{f.name}</span>
        <Chip>nv {f.level}</Chip>
        {f.badgeId && <Chip tone="info">{f.badgeId}</Chip>}
        {power !== undefined && (
          <Chip tone="accent" title={exact ? 'atributos que o jogo carregou nesta luta' : 'estimado'}>
            PWR {exact ? '' : '~'}
            {fmt(power)}
          </Chip>
        )}
      </div>
      {exact && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-[#2f4a24] bg-[#16220f] px-2 py-1.5 text-[11px] text-[#a8dd97]">
          <span className="font-semibold">números do jogo:</span>
          <span className="num">ATK {fmt1(exact.atk)}</span>
          <span className="num">DEF {fmt1(exact.def)}</span>
          <span className="num">CRIT {fmt1(exact.crit)}%</span>
          <span className="num">PARRY {fmt1(exact.parry)}%</span>
        </div>
      )}
      <PerkRow ids={perkIds} side={side} />
      <Bar
        value={f.maxHp}
        max={f.maxHp}
        color={side === 'you' ? 'linear-gradient(90deg,#6b4f12,var(--color-gold))' : 'linear-gradient(90deg,#7a2a22,var(--color-hp))'}
        right={`${fmt(f.maxHp)} HP`}
        label="vida máxima"
      />
      <div className="flex flex-col gap-px">
        {gear.map((g) => {
          const item = BY_NAME.get(g.name);
          return (
            <div key={g.slot} className="flex items-baseline gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-surface-2" title={item?.effects.join('\n')}>
              <span className="w-[58px] shrink-0 text-[10px] tracking-[0.5px] text-muted uppercase">{g.slot}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: rarityColor(g.rarity) }}>
                {g.name || '—'}
              </span>
              {g.element !== 'Nessuna' && <Chip tone="info">{g.element}</Chip>}
              {item ? (
                <span className="num shrink-0 text-[10px] text-muted">
                  {[item.hp && `${item.hp} PV`, item.atk && `${fmt1(item.atk)} ATK`, item.def && `${fmt1(item.def)} DEF`, item.crit && `${fmt1(item.crit)}% CRIT`, item.parry && `${fmt1(item.parry)}% PAR`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : (
                <Chip tone="warn">fora do catálogo</Chip>
              )}
            </div>
          );
        })}
      </div>
      {analysis && analysis.build.effects.length > 0 && (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer select-none">{analysis.build.effects.length} efeitos no equipamento</summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {analysis.build.effects.map((e, i) => (
              <li key={i} className="rounded bg-surface-2 px-1.5 py-0.5">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="grid grid-cols-4 gap-1 text-center">
        <Mini label="golpes" value={`${fmt(tally.landed)}/${fmt(tally.attacks)}`} />
        <Mini label="críticos" value={tally.landed ? `${fmt1((tally.crits / tally.landed) * 100)}%` : '—'} />
        <Mini label="dano" value={fmt(tally.damage)} />
        <Mini label="maior" value={fmt(tally.best)} />
      </div>
    </div>
  );
}

/**
 * Perks side by side. Ours come from the save, so they are the loadout we have *now* — the replay
 * does not record perks, so an old fight is shown with today's. The opponent's exist only when the
 * live tap scouted them (PlayerSnapshot.equippedPerkIds); ReplayFighter has no such field.
 */
function PerkRow({ ids, side }: { ids?: number[]; side: 'you' | 'them' }) {
  if (!ids?.length) {
    return (
      <div className="text-[11px] text-muted" title="ReplayFighter guarda só nome, nível, vida máxima, equipamento e emblema.">
        {side === 'them' ? 'perks do adversário: só com o modo ao vivo ligado na hora da luta' : 'perks: sem save carregado'}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] tracking-[0.5px] text-muted uppercase">perks</span>
      {ids.map((id) => {
        const p = PERKS.find((x) => x.id === id);
        return (
          <Chip key={id} tone={side === 'you' ? 'accent' : 'info'} title={p?.effect ?? `perk ${id}`}>
            <Icon family="perks" id={id} scale={0.6} /> {p?.name ?? `perk ${id}`}
          </Chip>
        );
      })}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-1 py-1.5">
      <div className="num text-[14px] leading-none font-semibold">{value}</div>
      <div className="mt-1 text-[10px] tracking-[0.5px] text-muted uppercase">{label}</div>
    </div>
  );
}

/** Side by side: what the gear gives, what the fight showed, and how the two builds compare. */
function Comparison({ a, scouted }: { a: ReplayAnalysis; scouted?: PvpScouted }) {
  const rows: Array<{ key: 'hp' | 'atk' | 'def' | 'crit' | 'parry'; label: string; suffix?: string }> = [
    { key: 'hp', label: 'Vida' },
    { key: 'atk', label: 'ATK' },
    { key: 'def', label: 'DEF' },
    { key: 'crit', label: 'CRIT', suffix: '%' },
    { key: 'parry', label: 'PARRY', suffix: '%' },
  ];
  const them = scouted ? { hp: scouted.maxHp, atk: scouted.atk, def: scouted.def, crit: scouted.crit, parry: scouted.parry } : a.them.stats;
  const themPower = powerScore(them);
  return (
    <Panel
      title="Como as duas builds se comparam"
      actions={
        <span className="flex gap-1.5">
          {scouted ? <Chip tone="up">adversário: números do jogo</Chip> : <Chip tone="warn">adversário: medido na luta</Chip>}
          <Chip tone="info">você: {a.exactPlayerStats ? 'do jogo' : 'do seu equipamento no replay'}</Chip>
        </span>
      }
    >
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[10px] tracking-[0.6px] text-muted uppercase">
            <th className="py-1.5 pr-2">atributo</th>
            <th className="py-1.5 pr-2 text-right">você</th>
            <th className="py-1.5 pr-2 text-right">adversário</th>
            <th className="py-1.5 pr-2">dele, só o equipamento</th>
            <th className="py-1.5">diferença</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label, suffix }) => {
            const mine = a.you.stats[key];
            const theirs = them[key];
            const gear = a.them.build.gear[key];
            const diff = mine - theirs;
            return (
              <tr key={key} className="border-t border-row">
                <td className="py-1.5 pr-2 text-muted">{label}</td>
                <td className="num py-1.5 pr-2 text-right text-gold">{key === 'hp' ? fmt(mine) : fmt1(mine)}{suffix}</td>
                <td className="num py-1.5 pr-2 text-right">{key === 'hp' ? fmt(theirs) : fmt1(Math.max(0, theirs))}{suffix}</td>
                <td className="num py-1.5 pr-2 text-muted">{key === 'hp' ? fmt(gear) : fmt1(gear)}{suffix}</td>
                <td className={cn('num py-1.5', diff >= 0 ? 'text-up' : 'text-down')}>
                  {diff >= 0 ? '+' : ''}
                  {key === 'hp' ? fmt(diff) : fmt1(diff)}
                  {suffix}
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-line-2">
            <td className="py-1.5 pr-2 text-muted">PWR</td>
            <td className="num py-1.5 pr-2 text-right text-gold">{fmt(a.you.power)}</td>
            <td className="num py-1.5 pr-2 text-right">{fmt(themPower)}</td>
            <td className="py-1.5 pr-2" />
            <td className={cn('num py-1.5', a.you.power >= themPower ? 'text-up' : 'text-down')}>
              {a.you.power >= themPower ? '+' : ''}
              {fmt(a.you.power - themPower)}
            </td>
          </tr>
        </tbody>
      </table>

      <Grupo nota={`medido nos ${a.turns} turnos desta luta`}>O que a luta mostrou</Grupo>
      <div className="flex flex-col gap-2">
        <MeasuredRow m={a.you.measured} label="você" tone="you" />
        <MeasuredRow m={a.them.measured} label="adversário" tone="them" />
      </div>

      <div className="text-[11px] leading-relaxed text-muted">
        O equipamento é exato: o replay guarda o nome de cada peça, e cada peça sempre tem os mesmos atributos. Os atributos do
        adversário saem da própria luta, invertendo a fórmula de dano sobre {a.turns} turnos, tendo os seus como referência — então são
        valores <b>efetivos</b>: já incluem os perks dele, o elemento das armas e qualquer bônus de PvP.{' '}
        {scouted
          ? 'Como o modo ao vivo já encontrou esse adversário, a coluna dele usa os números que o jogo carregou.'
          : 'Com o modo ao vivo ligado, da próxima vez que ele aparecer guardamos os números exatos.'}
      </div>
    </Panel>
  );
}

/** One line of numbers straight from the turns: nothing here is inferred. */
function MeasuredRow({ m, label, tone }: { m: Measured; label: string; tone: 'you' | 'them' }) {
  const color = tone === 'you' ? 'text-gold' : 'text-down';
  return (
    <div className="grid grid-cols-[76px_repeat(5,1fr)] items-center gap-1.5">
      <span className={cn('text-[10px] tracking-[0.6px] uppercase', color)}>{label}</span>
      <Mini label="dano/golpe" value={fmt1(m.meanHit)} />
      <Mini label="críticos" value={m.critPct === null ? '—' : `${fmt1(m.critPct)}%`} />
      <Mini label="aparou" value={m.parryPct === null ? '—' : `${fmt1(m.parryPct)}%`} />
      <Mini label="cura/golpe" value={m.healPerHit ? fmt1(m.healPerHit) : '—'} />
      <Mini label="contra-ataque" value={m.counterPct ? `${fmt1(m.counterPct)}%` : '—'} />
    </div>
  );
}

function HpChart({ r }: { r: PvpReplay }) {
  const log = r.log ?? [];
  const w = 640;
  const h = 150;
  const n = Math.max(1, log.length - 1);
  const maxHp = Math.max(r.player.maxHp, r.opponent.maxHp, 1);
  const line = (pick: (t: (typeof log)[number]) => number) => log.map((t, i) => `${(i / n) * w},${h - (pick(t) / maxHp) * h}`).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-4 text-xs text-muted">
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-gold align-middle" />
          {r.player.name} ({fmt(r.player.maxHp)} HP)
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-down align-middle" />
          {r.opponent.name} ({fmt(r.opponent.maxHp)} HP)
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[170px] w-full rounded-[10px] border border-line bg-bg-2" preserveAspectRatio="none" role="img" aria-label="HP por turno">
        <polyline points={line((t) => t.hpPlayer)} fill="none" stroke="var(--color-gold)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polyline points={line((t) => t.hpEnemy)} fill="none" stroke="var(--color-down)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="text-[11px] text-muted">
        {r.turns} turnos · {clock(r.t)} · replay {r.file}
      </div>
    </div>
  );
}
