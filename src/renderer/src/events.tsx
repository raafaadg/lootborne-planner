import type { ReactNode } from 'react';
import type { GameEvent } from '@shared/contracts';
import { sector } from './catalog';
import { Chip, RarityName, clock, fmt } from './ui';

type Tone = 'muted' | 'up' | 'down' | 'warn' | 'accent' | 'info';

export const EVENT_LABEL: Record<GameEvent['kind'], string> = {
  battle: 'Luta',
  level_up: 'Nível',
  drop: 'Drop',
  item_removed: 'Itens usados',
  death: 'Morte',
  sector_change: 'Setor',
  battle_paused: 'Pausa',
  battle_resumed: 'Retomou',
  pvp: 'PvP',
  autofight: 'Autofight',
  stat_points: 'Pontos',
};

export function describe(e: GameEvent): { tone: Tone; text: ReactNode } {
  switch (e.kind) {
    case 'battle': {
      // PvP and the PvP bosses leave the PvE HP alone: only the sector fights show it
      const pvp = e.mode === 'pvp' || e.mode === 'boss' || e.mode === 'friendly';
      const who = e.enemy ? (
        <b style={{ color: e.mode === 'boss' ? 'var(--color-gold)' : e.enemyColor ? `var(--color-enemy-${['Grigio', 'Blu', 'Viola'].indexOf(e.enemyColor)})` : undefined }}>{e.enemy}</b>
      ) : pvp ? (
        e.mode === 'boss' ? 'Boss de PvP' : 'Adversário de PvP'
      ) : (
        `Inimigo ${e.enemyIndex}`
      );
      return {
        tone: e.won === false ? 'down' : 'muted',
        text: (
          <>
            {e.mode === 'boss' ? 'Boss · ' : pvp ? 'PvP · ' : ''}
            {who}
            {pvp && e.won !== undefined ? (e.won ? ' · vitória' : ' · derrota') : ''}
            {' · '}+{fmt(e.xp)} XP{pvp ? '' : ` · HP ${fmt(e.hp[0])}→${fmt(e.hp[1])}`} · stamina {e.stamina[1].toFixed(1)}
            {e.durationMs !== undefined ? ` · ${Math.round(e.durationMs / 100) / 10} s` : ''}
          </>
        ),
      };
    }
    case 'level_up':
      return { tone: 'accent', text: <>Nível {e.from} → <b>{e.to}</b>{e.unspent > 0 ? ` · ${e.unspent} pontos para distribuir` : ''}</> };
    case 'drop':
      return {
        tone: e.item.rarity === 'Common' ? 'muted' : 'up',
        text: (
          <>
            <RarityName rarity={e.item.rarity}>{e.item.name}</RarityName> <span className="text-muted">({e.item.rarity}{e.item.grantSource && e.item.grantSource !== 'CombatDrop' ? ` · ${e.item.grantSource}` : ''})</span>
          </>
        ),
      };
    case 'item_removed':
      return { tone: 'muted', text: <>{e.items.length} item(ns) saíram do inventário (forja/desmonte): {e.items.slice(0, 4).map((i) => i.name).join(', ')}{e.items.length > 4 ? '…' : ''}</> };
    case 'death':
      return { tone: 'down', text: <>Morreu no setor {sector(e.sector)?.name ?? e.sector} · {e.deathsInSector} mortes neste setor; o progresso voltou ao início</> };
    case 'sector_change':
      return { tone: e.cleared ? 'accent' : 'info', text: <>{e.cleared ? 'Setor concluído! ' : ''}{sector(e.from)?.name ?? e.from} → <b>{sector(e.to)?.name ?? e.to}</b></> };
    case 'battle_paused':
      return { tone: 'warn', text: <>Batalha pausada (HP {fmt(e.hp)}, stamina {e.stamina.toFixed(1)})</> };
    case 'battle_resumed':
      return { tone: 'info', text: <>Batalha retomada (HP {fmt(e.hp)}, stamina {e.stamina.toFixed(1)})</> };
    case 'pvp':
      return { tone: e.won ? 'up' : 'down', text: <>{e.won ? 'Vitória' : 'Derrota'} contra <b>{e.opponent}</b> (nv {e.opponentLevel}) em {e.turns} turnos{e.friendly ? ' · amistoso' : ''}</> };
    case 'autofight':
      return {
        tone: e.on ? 'up' : 'warn',
        text: e.on ? `Autofight ligado${e.fromPlayer ? ' (você)' : ''}` : `Autofight desligado${e.reason === 'stamina' ? ': stamina esgotada' : e.fromPlayer ? ' (você)' : ''}`,
      };
    case 'stat_points':
      return { tone: 'accent', text: <>{e.unspent} pontos de atributo disponíveis</> };
  }
}

export function EventRow({ e, compact }: { e: GameEvent; compact?: boolean }) {
  const d = describe(e);
  return (
    <li className="flex items-baseline gap-2 border-b border-row py-1.5 text-[13px] last:border-0">
      <span className="num w-[62px] shrink-0 text-xs text-muted">{clock(e.t)}</span>
      <span className="w-[92px] shrink-0">
        <Chip tone={d.tone}>{EVENT_LABEL[e.kind]}</Chip>
      </span>
      <span className={compact ? 'min-w-0 truncate' : 'min-w-0'}>{d.text}</span>
      {!compact && e.source !== 'save' && <span className="ml-auto shrink-0 text-[10px] text-muted uppercase">{e.source === 'live' ? 'ao vivo' : 'replay'}</span>}
    </li>
  );
}
