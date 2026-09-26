import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '@shared/contracts';
import { sector } from './catalog';
import { useNow, useSnapshot } from './hooks';
import { BattlesPage } from './pages/Battles';
import { InventoryPage } from './pages/Inventory';
import { LibraryPage } from './pages/Library';
import { OverviewPage } from './pages/Overview';
import { PvpPage } from './pages/Pvp';
import { SettingsPage } from './pages/Settings';
import { SimulatorPage } from './pages/Simulator';
import { TimelinePage } from './pages/Timeline';
import { Button, Pill, ago, cn } from './ui';

const MENU = [
  {
    group: 'Jogo',
    items: [
      { id: 'overview', icon: '🏠', label: 'Visão geral' },
      { id: 'battles', icon: '🗡️', label: 'Batalhas' },
      { id: 'simulator', icon: '🎲', label: 'Simulador' },
      { id: 'timeline', icon: '📜', label: 'Timeline' },
    ],
  },
  { group: 'Itens', items: [{ id: 'inventory', icon: '🎒', label: 'Inventário' }, { id: 'library', icon: '📚', label: 'Biblioteca' }] },
  { group: 'PvP', items: [{ id: 'pvp', icon: '⚔️', label: 'PvP' }] },
  { group: 'App', items: [{ id: 'settings', icon: '🔔', label: 'Alertas & Ao vivo' }] },
] as const;
type PageId = (typeof MENU)[number]['items'][number]['id'];

// Same contract as the BotFarm menu: collapsed state survives restarts, and storage may be unavailable.
function loadCollapsed(): boolean {
  try {
    return localStorage.getItem('menu-fechado') === '1';
  } catch {
    return false;
  }
}

export function App() {
  const snapshot = useSnapshot();
  const now = useNow();
  const [page, setPage] = useState<PageId>('overview');
  // each page starts at its top, not where the previous one was scrolled to
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // scrollTo returns a promise in current Chromium: keep it out of the effect's return value
    void mainRef.current?.scrollTo(0, 0);
  }, [page]);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleMenu = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('menu-fechado', c ? '0' : '1');
      } catch {
        // private storage; keep it in memory only
      }
      return !c;
    });
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-ink">
      <aside className={cn('flex h-dvh flex-none flex-col gap-1.5 border-r border-line bg-surface pt-3 pb-2.5 transition-[width] duration-150', collapsed ? 'w-[58px] px-[7px]' : 'w-[214px] px-2.5')}>
        <div className={cn('flex items-center gap-[9px] border-b border-line px-0.5 pb-2', collapsed && 'flex-col gap-1.5')}>
          <Marca />
          {!collapsed && (
            <div className="min-w-0 leading-tight whitespace-nowrap">
              <div className="text-[15px] font-semibold tracking-[0.2px]">Lootborne</div>
              <div className="text-[11px] font-semibold tracking-[0.5px] text-gold">Planner</div>
            </div>
          )}
          <Button mini onClick={toggleMenu} className={cn('flex-none px-[7px] text-[15px] leading-tight', !collapsed && 'ml-auto')} title={collapsed ? 'abrir o menu' : 'recolher o menu'}>
            {collapsed ? '›' : '‹'}
          </Button>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto">
          {MENU.map((g) => (
            <div key={g.group} className="flex flex-col gap-0.5">
              {!collapsed && <div className="px-2.5 pt-[9px] pb-0.5 text-[10px] tracking-[0.8px] whitespace-nowrap text-muted uppercase">{g.group}</div>}
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  title={it.label}
                  onClick={() => setPage(it.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-[9px] rounded-lg border px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap transition-colors',
                    collapsed && 'justify-center px-0',
                    page === it.id ? 'border-line-2 bg-surface-2 font-semibold text-gold' : 'border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  <i className="w-5 flex-none text-center text-sm not-italic">{it.icon}</i>
                  {!collapsed && <span>{it.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <Button onClick={() => void window.planner.openDataFolder()} title="Abrir a pasta de dados do jogo" className={cn('flex items-center justify-center gap-1.5 text-xs', collapsed && 'px-0')}>
            <span>📂</span>
            {!collapsed && <span>pasta do jogo</span>}
          </Button>
          {!collapsed && snapshot && <div className="px-1 text-center text-[10px] text-muted">v{snapshot.version}</div>}
        </div>
      </aside>

      <main ref={mainRef} className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-5">
        {snapshot ? <Header snapshot={snapshot} now={now} /> : <div className="text-muted">Carregando…</div>}
        {snapshot &&
          (page === 'overview' ? (
            <OverviewPage snapshot={snapshot} now={now} />
          ) : page === 'battles' ? (
            <BattlesPage snapshot={snapshot} now={now} />
          ) : page === 'inventory' ? (
            <InventoryPage snapshot={snapshot} />
          ) : page === 'library' ? (
            <LibraryPage snapshot={snapshot} onOpenSimulator={() => setPage('simulator')} />
          ) : page === 'simulator' ? (
            <SimulatorPage snapshot={snapshot} />
          ) : page === 'timeline' ? (
            <TimelinePage snapshot={snapshot} />
          ) : page === 'pvp' ? (
            <PvpPage snapshot={snapshot} />
          ) : (
            <SettingsPage snapshot={snapshot} />
          ))}
      </main>
    </div>
  );
}

function Marca() {
  return (
    <div className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[11px] border border-line-2 bg-[linear-gradient(160deg,#2c2418,#191510)] text-[19px]">
      ⚔️
    </div>
  );
}

function Header({ snapshot, now }: { snapshot: AppSnapshot; now: number }) {
  const { live, save, gameRunning } = snapshot;
  const s = save?.state;
  const sec = s ? sector(s.currentSector) : undefined;
  const livePill =
    live.status === 'live' ? (
      <Pill state="on" pulse title={live.detail}>
        ao vivo{live.inCombat ? ' · em combate' : ''}
      </Pill>
    ) : live.status === 'waiting' || live.status === 'attaching' ? (
      <Pill state="alerta" title={live.detail}>ao vivo · aguardando</Pill>
    ) : live.status === 'error' || live.status === 'unavailable' ? (
      <Pill state="ruim" pulse title={live.detail}>ao vivo · erro</Pill>
    ) : (
      <Pill state="off">ao vivo desligado</Pill>
    );

  return (
    <header className="mb-3 flex flex-wrap items-center gap-3 border-b border-line pb-2.5">
      <div className="min-w-0">
        <h1 className="m-0 text-[17px] font-semibold tracking-[0.2px]">
          {s ? s.name : 'Lootborne'} {s && <span className="text-gold">· nível {s.level}</span>}
        </h1>
        <div className="text-[11px] tracking-[0.3px] text-muted">
          {s
            ? `${s.endlessMode ? `Arena · onda ${s.waveIndex} (${s.waveKillCount ?? 0}/10)` : `Setor ${s.currentSector}${sec ? ` · ${sec.name}` : ''}`} · ${s.battleActive ? 'lutando' : 'pausado'}`
            : (snapshot.saveError ?? 'procurando o save…')}
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Pill state={gameRunning ? 'on' : 'off'}>{gameRunning ? 'jogo aberto' : 'jogo fechado'}</Pill>
        {livePill}
        <div className="text-right text-[11px] leading-tight text-muted">
          {save ? <>save há {ago(save.writtenAt, now)}</> : 'sem save'}
          <br />
          {live.hooks ? `hooks ${live.hooks.ok.length}/${live.hooks.ok.length + live.hooks.failed.length}` : `sigVersion ${save?.sigVersion ?? '?'}`}
        </div>
      </div>
    </header>
  );
}
