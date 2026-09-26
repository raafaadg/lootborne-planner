import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { CombatKnowledge, DeepPartial, GameEvent, PvpScouted, Settings } from '@shared/contracts';
import { AppState } from './app-state';
import { gameDataDir } from './game-reader/paths';
import { ReplayReader } from './game-reader/replay-reader';
import { SaveReader } from './game-reader/save-reader';
import { FridaTap } from './live/frida-tap';
import { Notifier } from './notifier';
import { History } from './storage/history';
import { PvpArchive } from './storage/pvp-archive';
import { arenaFor } from './pvp-arena';
import { DEFAULT_SETTINGS, JsonStore, mergeSettings } from './storage/settings';
import { migrateFromCompanion } from './storage/migrate';

const SNAPSHOT_THROTTLE_MS = 250;
/** What the Batalhas page joins into fights: the fight, what came out of it, and what paused the loop. */
const BATTLE_KINDS = new Set<GameEvent['kind']>(['battle', 'drop', 'level_up', 'death', 'battle_paused', 'battle_resumed', 'autofight', 'sector_change']);

function isGameRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Lootborne.exe', '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, stdout) =>
      resolve(!err && /lootborne\.exe/i.test(stdout)),
    );
  });
}

// Dev-only: LBP_DEBUG_PORT exposes the renderer over the DevTools protocol for automated checks.
if (process.env.LBP_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.LBP_DEBUG_PORT);
// Dev-only: LBP_USER_DATA points the app at another data folder, so a test run touches nothing real.
if (process.env.LBP_USER_DATA) app.setPath('userData', process.env.LBP_USER_DATA);

/**
 * Startup trouble goes to startup.log, in the data folder when it can be written and in the temp
 * folder otherwise, so a user whose window never opens has something to send.
 */
function userDataDir(): string {
  try {
    return app.getPath('userData');
  } catch {
    return tmpdir();
  }
}
function startupLog(line: string): string {
  for (const dir of [userDataDir(), tmpdir()]) {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'startup.log');
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      return path;
    } catch {
      // not writable: try the next folder
    }
  }
  return '';
}
/** Set once the window is on screen: a failure before that must not leave a process with no window. */
let windowShown = false;
function failedToStart(e: unknown): void {
  const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
  const log = startupLog(`startup failed: ${text}`);
  if (windowShown) return;
  dialog.showErrorBox('Lootborne Planner não conseguiu abrir', `${e instanceof Error ? e.message : text}${log ? `\n\nDetalhes em: ${log}` : ''}`);
  app.exit(1);
}
process.on('uncaughtException', (e) => (windowShown ? void startupLog(`uncaughtException: ${e.stack ?? e}`) : failedToStart(e)));
process.on('unhandledRejection', (e) => (windowShown ? void startupLog(`unhandledRejection: ${e instanceof Error ? e.stack : String(e)}`) : failedToStart(e)));

// Software rendering when asked (--disable-gpu / --safe-mode) or after the graphics process died
// before the window could show (the marker file, written below): a broken video driver, a virtual
// machine or a remote desktop can keep Chromium from ever painting the first frame.
const GPU_MARKER = join(userDataDir(), 'disable-gpu');
const softwareRendering = process.argv.includes('--disable-gpu') || process.argv.includes('--safe-mode') || existsSync(GPU_MARKER);
if (softwareRendering) app.disableHardwareAcceleration();

async function main(): Promise<void> {
  // Two copies would both append to the same history and double every event, so only one runs.
  // Dev runs (LBP_DEBUG_PORT) are exempt so a build can be checked next to an installed copy.
  if (app.isPackaged && !process.env.LBP_DEBUG_PORT && !app.requestSingleInstanceLock()) {
    startupLog('another copy is already running: asking it to show its window');
    app.quit();
    return;
  }
  startupLog(`start v${app.getVersion()} · Windows ${release()} · ${process.execPath}${softwareRendering ? ' · software rendering' : ''}`);
  await app.whenReady();
  const userData = app.getPath('userData');
  // The app used to be Lootborne Companion; bring its data (above all the PvP archive) across once.
  const migrated = migrateFromCompanion(userData, join(app.getPath('appData'), 'lootborne-companion'));
  const settingsStore = new JsonStore<Settings>(userData, 'settings.json', DEFAULT_SETTINGS);
  const xpStore = new JsonStore<Record<number, number>>(userData, 'xp-table.json', {});
  const combatStore = new JsonStore<CombatKnowledge>(userData, 'combat.json', {});
  const scoutStore = new JsonStore<Record<string, PvpScouted>>(userData, 'pvp-scouts.json', {});
  const history = new History(userData);

  const state = new AppState(settingsStore.load(), history.recent(500));
  state.version = app.getVersion();
  state.xpTable = xpStore.load();
  state.combat = combatStore.load();
  state.scouts = scoutStore.load();
  const notifier = new Notifier(state);
  state.on('event', (e) => history.append(e));
  state.on('scout', () => scoutStore.save(state.scouts));

  const saves = new SaveReader();
  saves.on('save', (read) => state.onSave(read));
  saves.on('error', (message) => state.onSaveError(message));
  saves.start();

  const pvpArchive = new PvpArchive(userData);
  const replays = new ReplayReader(pvpArchive);
  replays.on('history', (list) => state.onReplayHistory(list));
  replays.on('replay', (replay) => state.onReplay(replay));
  void replays.start();

  // Diagnostics for the live tap: status changes and anything that is not routine traffic.
  const liveLog = (line: string) => appendFileSync(join(userData, 'live.log'), `${new Date().toISOString()} ${line}\n`);
  if (migrated) liveLog(`migrated from ${migrated.from}: ${migrated.copied.join(', ') || 'nothing to copy'}`);
  const ROUTINE = new Set(['turn', 'player', 'hb', 'save', 'power', 'screen', 'stats', 'perk_mods']);
  const tap = new FridaTap();
  tap.on('status', (status, info) => {
    liveLog(`status=${status}${info.pid ? ` pid=${info.pid}` : ''}${info.detail ? ` ${info.detail}` : ''}`);
    state.onLiveStatus(status, info);
  });
  tap.on('message', (msg) => {
    if (!ROUTINE.has(msg.ev)) liveLog(JSON.stringify(msg));
    state.onAgentMessage(msg);
    if (msg.ev === 'xp_needed') xpStore.save(state.xpTable);
    if (msg.ev === 'stats' || msg.ev === 'perk_mods' || msg.ev === 'ready') combatStore.save(state.combat);
  });
  if (state.settings.live.enabled) void tap.enable();

  // Registered before the window exists: the renderer asks for its first snapshot on load.
  ipcMain.handle('snapshot:get', () => state.snapshot());
  ipcMain.handle('settings:update', async (_e, patch: DeepPartial<Settings>) => {
    const before = state.settings;
    state.settings = mergeSettings(before, patch);
    if (!before.live.enabled && state.settings.live.enabled) {
      state.settings.live.consentAt ??= new Date().toISOString();
      await tap.enable();
    } else if (before.live.enabled && !state.settings.live.enabled) {
      await tap.disable();
    }
    settingsStore.save(state.settings);
    applyZoom();
    state.emit('changed');
    return state.settings;
  });
  ipcMain.handle('stats:reset', () => state.resetStats());
  // The snapshot carries only the most recent fights; the PvP page asks for the rest.
  ipcMain.handle('pvp:history', () => pvpArchive.summaries());
  ipcMain.handle('pvp:detail', (_e, file: string) => pvpArchive.detail(String(file)));
  // The opponents the PvP goal is scored against: built here because only the archive has the turn logs.
  ipcMain.handle('pvp:arena', (_e, limit: number) => arenaFor(state, pvpArchive, Number(limit) || 16));
  // The Batalhas page reaches further back than the snapshot's 300 events.
  ipcMain.handle('battles:history', (_e, limit: number) => history.recent(Math.min(20_000, Number(limit) || 3_000), BATTLE_KINDS));
  ipcMain.handle('notify:test', () => notifier.send({ title: 'Lootborne Planner', body: 'Notificações funcionando' }, true));
  ipcMain.handle('shell:openDataFolder', () => shell.openPath(gameDataDir()));

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    title: 'Lootborne Planner',
    backgroundColor: '#1b1814',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  // Chromium zoom scales every font and control together; reapplied on each load (it is per page)
  const applyZoom = () => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(Math.min(2, Math.max(0.8, state.settings.ui?.zoom ?? 1.15)));
  };
  win.webContents.on('did-finish-load', applyZoom);
  let shown = false;
  const showWindow = (why: string) => {
    if (win.isDestroyed() || shown) return;
    shown = true;
    windowShown = true;
    if (why !== 'ready') startupLog(`window shown: ${why}`);
    win.show();
  };
  win.once('ready-to-show', () => showWindow('ready'));
  // ready-to-show waits for the first painted frame; if the graphics process never paints, the window
  // would stay hidden for good with the process alive in the Task Manager. Show it anyway.
  setTimeout(() => showWindow('ready-to-show did not fire within 8 s'), 8_000);
  app.on('child-process-gone', (_e, d) => {
    startupLog(`child process gone: ${d.type} · ${d.reason} · exit ${d.exitCode}`);
    // the graphics process died before anything showed: start over once in software rendering
    if (d.type === 'GPU' && !shown && !softwareRendering) {
      try {
        writeFileSync(GPU_MARKER, 'The graphics process crashed before the window opened; the Planner now renders in software. Delete this file to try the GPU again.\n');
      } catch {
        // the relaunch still gets --disable-gpu
      }
      app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu'] });
      app.exit(0);
    }
  });
  let reloads = 0;
  win.webContents.on('render-process-gone', (_e, d) => {
    startupLog(`page gone: ${d.reason} · exit ${d.exitCode}`);
    if (d.reason !== 'clean-exit' && reloads++ < 2 && !win.isDestroyed()) win.reload();
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => startupLog(`page failed to load: ${code} ${description} ${url}`));
  app.on('second-instance', () => {
    // a second launch shows this window, even one that never managed to show itself
    showWindow('second launch');
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  let pending: NodeJS.Timeout | null = null;
  state.on('changed', () => {
    pending ??= setTimeout(() => {
      pending = null;
      if (!win.isDestroyed()) win.webContents.send('snapshot', state.snapshot());
    }, SNAPSHOT_THROTTLE_MS);
  });

  const checks = setInterval(async () => {
    const running = await isGameRunning();
    if (running !== state.gameRunning) {
      state.gameRunning = running;
      state.emit('changed');
    }
    notifier.check();
  }, 5_000);
  state.gameRunning = await isGameRunning();

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    clearInterval(checks);
    saves.stop();
    replays.stop();
  });
  app.on('will-quit', (event) => {
    if (tap.pid === null) return;
    event.preventDefault();
    void tap.disable().finally(() => app.exit(0)); // never leave the agent loaded in the game
  });
}

// anything that fails before the window shows would leave a process with no window and no word: say
// what happened and where the details are, then quit
main().catch(failedToStart);
