import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  ENEMY_COLORS,
  GRANT_SOURCES,
  SCREENS,
  type AppSnapshot,
  type CombatKnowledge,
  type FightEnemyStats,
  type FightMode,
  type GameEvent,
  emptyTally,
  type LiveEnemy,
  type LiveState,
  type LiveTurn,
  type LiveStatus,
  type PvpReplay,
  type PvpScouted,
  ELEMENTS,
  type SaveState,
  type SaveView,
  type SessionStats,
  type Settings,
  type SideTally,
} from '@shared/contracts';
import { ARENA_NAME, PVP_BOSSES, bossByName } from '@shared/battles';
import { rarityName, xpNeededForNextLevel } from '@shared/game-math';
import { applyTurn } from './game-reader/replay-reader';
import { diffSaves, type NewEvent } from './game-reader/save-diff';
import type { SaveRead } from './game-reader/save-reader';
import type { AgentMessage } from './live/frida-tap';

const MAX_EVENTS = 500;
const MAX_PVP = 40;
const MAX_LIVE_TURNS = 80;
const RATE_WINDOW_MS = 30 * 60_000;
const LIVE_MERGE_MS = 20_000;
/** The save can land a few ms before the tap's combat_end; hold its battle this long for it. */
const PENDING_BATTLE_MS = 1_500;
/** A boss-appeared save (bossPvpCounter back to 0) labels the next PvP fight within this window. */
const BOSS_APPEAR_MS = 5 * 60_000;

interface CombatEnd {
  at: number;
  won: boolean;
  enemy: string | null;
  color: LiveEnemy['color'];
  xp: number;
  mode: FightMode;
  bossIndex?: number;
  enemyLevel?: number;
  durationMs?: number;
  turns?: number;
  you?: SideTally;
  them?: SideTally;
  enemyStats?: FightEnemyStats;
  rpDelta?: number;
  arenaBoss?: boolean;
}

type BattleNew = Extract<NewEvent, { kind: 'battle' }>;

/**
 * The Planner's single source of truth. Fed by the save reader (always), the replay reader and
 * the optional Frida tap; produces the timeline, session stats and live state the UI renders.
 */
export class AppState extends EventEmitter<{ changed: []; event: [GameEvent]; scout: [PvpScouted] }> {
  version = '0.0.0';
  gameRunning = false;
  save: SaveView | null = null;
  saveError: string | undefined;
  events: GameEvent[] = [];
  pvp: PvpReplay[] = [];
  live: LiveState = { status: 'off', inCombat: false };
  xpTable: Record<number, number> = {};
  combat: CombatKnowledge = {};
  /** PvP opponents met with the live tap on, by name: their real stats. */
  scouts: Record<string, PvpScouted> = {};
  lastSaveAt = 0;
  /** Where the session counters start; moves forward when the player zeroes them. */
  sessionStart = Date.now();

  #liveDropUids = new Set<number>();
  #lastCombatEnd: CombatEnd | null = null;
  #lastEnemyColor: LiveEnemy['color'] = null;
  /** when the tap saw the current fight start (null: it attached mid-fight, so no duration) */
  #fightStartAt: number | null = null;
  #pendingBattle: { e: BattleNew; t: string; xpKnown: boolean; timer: NodeJS.Timeout } | null = null;
  #bossAppearedAt = 0;

  constructor(public settings: Settings, history: GameEvent[] = []) {
    super();
    this.events = history.slice(-MAX_EVENTS);
  }

  // ---- save -------------------------------------------------------------------------------

  onSave(read: SaveRead): void {
    const prev = this.save?.state;
    this.save = { state: read.state, path: read.path, writtenAt: new Date(read.mtimeMs).toISOString(), sigVersion: read.sigVersion };
    this.saveError = undefined;
    this.lastSaveAt = Date.now();
    if (prev) {
      // BossPvpEncounter.OnAppear puts the counter back to 0: the next PvP fight is the boss
      const counter = read.state.bossPvpCounter;
      if (typeof counter === 'number' && typeof prev.bossPvpCounter === 'number' && counter < prev.bossPvpCounter) this.#bossAppearedAt = Date.now();
      // one timestamp per save, so a fight and its drops / level-up stay together
      const t = new Date().toISOString();
      for (const e of diffSaves(prev, read.state)) this.#fromSave(e, prev, read.state, t);
    }
    this.emit('changed');
  }

  onSaveError(message: string): void {
    this.saveError = message;
    this.emit('changed');
  }

  #fromSave(e: NewEvent, prev: SaveState, next: SaveState, t: string): void {
    if (e.kind === 'drop' && this.#liveDropUids.has(e.item.uid)) return; // the tap reported it first
    if (e.kind === 'battle') {
      // a level-up splits the XP across two levels: the diff alone gives 0
      let xpKnown = next.level === prev.level;
      if (!xpKnown) {
        const needed = this.xpTable[prev.level];
        if (needed) {
          e.xp = Math.max(0, needed - prev.xp) + next.xp;
          xpKnown = true;
        } else if (next.level === prev.level + 1) {
          // XPSystem's curve (it can be 1 off: the game rounds in float32), so the tap's own figure
          // for the fight still wins when there is one
          e.xp = Math.max(0, xpNeededForNextLevel(prev.level) - prev.xp) + next.xp;
        }
      }
      if (e.mode === 'pvp' && Date.now() - this.#bossAppearedAt < BOSS_APPEAR_MS) {
        this.#bossAppearedAt = 0;
        e.mode = 'boss';
        const band = PVP_BOSSES.filter((b) => prev.level >= b.level).at(-1);
        if (band) e.bossIndex = band.index;
      }
      const live = this.#lastCombatEnd;
      if (live && Date.now() - live.at < LIVE_MERGE_MS) {
        this.#lastCombatEnd = null;
        this.#push(mergeLive(e, live, xpKnown), 'save', t);
        return;
      }
      if (this.live.status === 'live' && this.live.inCombat) {
        this.#holdBattle(e, t, xpKnown);
        return;
      }
    }
    this.#push(e, 'save', t);
  }

  /** The save beat the tap's combat_end by a few ms: wait for it rather than lose the live details. */
  #holdBattle(e: BattleNew, t: string, xpKnown: boolean): void {
    this.#flushPending();
    const timer = setTimeout(() => this.#flushPending(), PENDING_BATTLE_MS);
    this.#pendingBattle = { e, t, xpKnown, timer };
  }

  #flushPending(live?: CombatEnd): void {
    const pending = this.#pendingBattle;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingBattle = null;
    this.#push(live ? mergeLive(pending.e, live, pending.xpKnown) : pending.e, 'save', pending.t);
    this.emit('changed');
  }

  // ---- replays ----------------------------------------------------------------------------

  /** Bulk load from the archive at startup: no timeline events, they are already in the history. */
  onReplayHistory(replays: PvpReplay[]): void {
    this.pvp = replays.slice(0, MAX_PVP);
    this.emit('changed');
  }

  onReplay(replay: PvpReplay): void {
    this.pvp = [replay, ...this.pvp.filter((p) => p.file !== replay.file)]
      .sort((a, b) => b.t.localeCompare(a.t))
      .slice(0, MAX_PVP);
    this.#push(
      { kind: 'pvp', won: replay.won, friendly: replay.friendly, opponent: replay.opponent.name, opponentLevel: replay.opponent.level, turns: replay.turns },
      'replay',
    );
    this.emit('changed');
  }

  // ---- live (Frida) -----------------------------------------------------------------------

  onLiveStatus(status: LiveStatus, info: { detail?: string; pid?: number }): void {
    const keep = status === 'live' || status === 'attaching';
    const since = status === 'live' ? (this.live.status === 'live' ? this.live.since : new Date().toISOString()) : undefined;
    this.live = {
      ...(keep ? this.live : {}),
      status,
      inCombat: keep && this.live.inCombat,
      detail: info.detail,
      pid: info.pid ?? (keep ? this.live.pid : undefined),
      since,
    };
    this.emit('changed');
  }

  onAgentMessage(msg: AgentMessage): void {
    const now = new Date().toISOString();
    this.live.lastMessageAt = now;
    switch (msg.ev) {
      case 'ready': {
        const hooks = msg.hooks as { ok: string[]; failed: string[] };
        this.live.hooks = hooks;
        const consts = msg.constants as
          | {
              regenBaselinePctBySector?: number[];
              enemyWeakBothWeaponsPct?: number;
              perkWeights?: Array<{ id: number; psWeight: number; tier?: number; combatEffect?: string }>;
              perkEconomyV2?: boolean | null;
            }
          | null;
        if (consts?.regenBaselinePctBySector?.length) this.combat = { ...this.combat, regenPct: consts.regenBaselinePctBySector };
        if (typeof consts?.enemyWeakBothWeaponsPct === 'number' && consts.enemyWeakBothWeaponsPct > 0) {
          this.combat = { ...this.combat, weakBothPct: consts.enemyWeakBothWeaponsPct };
        }
        if (consts?.perkWeights?.length) {
          this.combat = {
            ...this.combat,
            perkWeights: Object.fromEntries(consts.perkWeights.map((p) => [p.id, p.psWeight])),
            // the text each perk feeds into a fight, straight from PerkCatalog.All (may be empty)
            ...(consts.perkWeights.some((p) => typeof p.combatEffect === 'string')
              ? { perkTexts: Object.fromEntries(consts.perkWeights.map((p) => [p.id, p.combatEffect ?? ''])) }
              : {}),
            ...(consts.perkWeights.some((p) => typeof p.tier === 'number') ? { perkTiers: Object.fromEntries(consts.perkWeights.map((p) => [p.id, p.tier ?? 0])) } : {}),
          };
        }
        if (typeof consts?.perkEconomyV2 === 'boolean') this.combat = { ...this.combat, perkEconomyV2: consts.perkEconomyV2, perkEconomyAt: now };
        if (hooks.failed.length) this.live.detail = `${hooks.failed.length} hook(s) falharam`;
        break;
      }
      case 'combat_start': {
        const e = msg.enemy as Record<string, unknown> | null;
        if (e) {
          this.live.enemy = toEnemy(e);
          this.#lastEnemyColor = this.live.enemy.color;
        }
        this.live.inCombat = true;
        this.live.fight = { startedAt: now, enemy: this.live.enemy, turns: [], you: emptyTally(), them: emptyTally() };
        this.#fightStartAt = Date.now();
        this.#session().fights++;
        // A PvP opponent's EnemyState is built from their real build, perks included: worth keeping.
        const foe = this.live.enemy;
        if (foe?.isPvP && foe.name && foe.atk !== undefined) {
          // Merge, never replace: SnapshotToEnemyState fires first and carries the perks and the
          // ranking numbers, and EnemyState has none of those — overwriting would drop them.
          this.scouts = {
            ...this.scouts,
            [foe.name]: {
              ...this.scouts[foe.name],
              name: foe.name,
              at: now,
              level: foe.level,
              maxHp: foe.maxHp,
              atk: foe.atk,
              def: foe.def ?? 0,
              crit: foe.crit ?? 0,
              parry: foe.parry ?? 0,
            },
          };
          this.emit('scout', this.scouts[foe.name]!);
        }
        break;
      }
      // The arena's own record of an opponent: exact stats plus the perks the replay never keeps.
      case 'pvp_snapshot': {
        const name = typeof msg.name === 'string' ? msg.name : '';
        if (!name) break;
        const prev = this.scouts[name];
        const scout: PvpScouted = {
          name,
          at: now,
          level: Number(msg.level ?? prev?.level ?? 0),
          maxHp: Number(msg.maxHp ?? prev?.maxHp ?? 0),
          atk: Number(msg.atk ?? prev?.atk ?? 0),
          def: Number(msg.def ?? prev?.def ?? 0),
          crit: Number(msg.crit ?? prev?.crit ?? 0),
          parry: Number(msg.parry ?? prev?.parry ?? 0),
          ...(Array.isArray(msg.perkIds) ? { perkIds: (msg.perkIds as number[]).filter((id) => id > 0) } : {}),
          ...(msg.power !== undefined ? { power: Number(msg.power) } : {}),
          ...(msg.rankingPoints !== undefined ? { rankingPoints: Number(msg.rankingPoints) } : {}),
          ...(msg.mmr !== undefined ? { mmr: Number(msg.mmr) } : {}),
          ...(msg.matches !== undefined ? { matches: Number(msg.matches) } : {}),
        };
        this.scouts = { ...this.scouts, [name]: scout };
        this.emit('scout', scout);
        break;
      }
      case 'turn': {
        const attacking = Boolean(msg.playerAttacking);
        const enemyHp = Number(attacking ? msg.defenderHp : msg.attackerHp);
        const playerHp = Number(attacking ? msg.attackerHp : msg.defenderHp);
        if (this.live.enemy) this.live.enemy.hp = enemyHp;
        if (this.live.player) this.live.player.hp = playerHp;
        // attaching mid-fight, or a fight the start hook missed: no start, so no duration either
        if (!this.live.fight) {
          this.live.fight = { startedAt: now, enemy: this.live.enemy, turns: [], you: emptyTally(), them: emptyTally() };
          this.#fightStartAt = null;
        }
        const fight = this.live.fight;
        if (fight.endedAt) {
          Object.assign(fight, { startedAt: now, endedAt: undefined, won: undefined, enemy: this.live.enemy, turns: [], you: emptyTally(), them: emptyTally() });
          this.#fightStartAt = null;
        }
        const t: LiveTurn = {
          n: fight.turns.length + 1,
          playerAttacking: attacking,
          damage: Number(msg.damage),
          crit: Boolean(msg.crit),
          parried: Boolean(msg.parried),
          healPlayer: Number(msg.healPlayer ?? 0),
          healEnemy: Number(msg.healEnemy ?? 0),
          counterPlayer: Number(msg.counterPlayer ?? 0),
          counterEnemy: Number(msg.counterEnemy ?? 0),
          playerHp,
          enemyHp,
          at: now,
        };
        fight.turns.push(t);
        if (fight.turns.length > MAX_LIVE_TURNS) fight.turns.splice(0, fight.turns.length - MAX_LIVE_TURNS);
        applyTurn(fight.you, fight.them, t);
        const session = this.#session();
        applyTurn(session.you, session.them, t);
        this.live.lastTurn = { playerAttacking: attacking, damage: t.damage, crit: t.crit, parried: t.parried, at: now };
        this.live.inCombat = true;
        break;
      }
      case 'combat_end': {
        this.live.inCombat = false;
        const fight = this.live.fight;
        if (fight) {
          fight.endedAt = now;
          fight.won = Boolean(msg.won);
        }
        if (msg.won) this.#session().wins++;
        // Every fight, PvP and bosses included: the save's battle event picks this up (or already
        // waits for it) and becomes the one record of the fight.
        const foe = fight?.enemy ?? this.live.enemy;
        const name = typeof msg.enemy === 'string' ? msg.enemy : (foe?.name ?? null);
        const mode = fightMode(foe, name, Boolean(msg.isPvP));
        const startedAt = this.#fightStartAt;
        this.#fightStartAt = null;
        const bossIndex = mode === 'boss' ? (foe?.bossPvpIndex ?? bossByName(name)?.index) : undefined;
        const end: CombatEnd = {
          at: Date.now(),
          won: Boolean(msg.won),
          enemy: name,
          color: mode === 'pve' || mode === 'arena' ? this.#lastEnemyColor : null,
          xp: Number(msg.xp) || 0,
          mode,
          ...(bossIndex !== undefined && bossIndex >= 0 ? { bossIndex } : {}),
          ...(foe ? { enemyLevel: foe.level } : {}),
          ...(startedAt !== null ? { durationMs: Date.now() - startedAt } : {}),
          ...(fight && startedAt !== null
            ? { turns: fight.you.attacks + fight.them.attacks, you: { ...fight.you }, them: { ...fight.them } }
            : {}),
          ...(foe && foe.atk !== undefined
            ? { enemyStats: { hp: foe.maxHp, atk: round2(foe.atk), def: round2(foe.def ?? 0), crit: round2(foe.crit ?? 0), parry: round2(foe.parry ?? 0) } }
            : {}),
          ...(Number(msg.rpDelta) ? { rpDelta: Number(msg.rpDelta) } : {}),
          ...(foe?.isArenaBoss ? { arenaBoss: true } : {}),
        };
        if (this.#pendingBattle) this.#flushPending(end);
        else this.#lastCombatEnd = end;
        break;
      }
      case 'add_item': {
        const it = msg.item as { uid: number; templateId: number; name: string; slot: number; rarity: number; grantSource: number } | null;
        if (it && !this.#liveDropUids.has(it.uid)) {
          this.#liveDropUids.add(it.uid);
          const known = this.save?.state.inventory.some((i) => i.uid === it.uid);
          if (!known) {
            this.#push({ kind: 'drop', item: { uid: it.uid, templateId: it.templateId, name: it.name, slot: it.slot, rarity: rarityName(it.rarity), grantSource: GRANT_SOURCES[it.grantSource] ?? String(it.grantSource) } }, 'live');
          }
        }
        break;
      }
      case 'screen':
        this.live.screen = SCREENS[Number(msg.screen)];
        break;
      case 'player': {
        this.live.player = { hp: Number(msg.hp), stamina: Number(msg.stamina), level: Number(msg.level), xp: Number(msg.xp), battleActive: Boolean(msg.battleActive) };
        if (msg.screen !== null && msg.screen !== undefined) this.live.screen = SCREENS[Number(msg.screen)];
        if (Array.isArray(msg.equipped)) {
          this.live.equipment = { uids: (msg.equipped as number[]).map(Number), perkIds: Array.isArray(msg.perks) ? (msg.perks as number[]).map(Number) : [], at: now };
        }
        break;
      }
      case 'autofight': {
        this.live.autofight = { on: Boolean(msg.on), fromPlayer: Boolean(msg.fromPlayer), at: now };
        this.#push({ kind: 'autofight', on: Boolean(msg.on), fromPlayer: Boolean(msg.fromPlayer) }, 'live');
        break;
      }
      case 'autofight_stamina': {
        this.live.autofight = { on: false, fromPlayer: false, at: now, reason: 'stamina' };
        this.#push({ kind: 'autofight', on: false, fromPlayer: false, reason: 'stamina' }, 'live');
        break;
      }
      case 'power':
        this.live.power = Number(msg.value);
        break;
      case 'xp_needed':
        this.xpTable[Number(msg.level)] = Number(msg.value);
        break;
      case 'stats':
        this.combat = {
          ...this.combat,
          stats: { hp: Number(msg.hp), atk: Number(msg.atk), def: Number(msg.def), crit: Number(msg.crit), parry: Number(msg.parry) },
          statsAt: now,
        };
        break;
      case 'perk_mods':
        this.combat = {
          ...this.combat,
          perkMods: msg.mods as Record<string, number | boolean>,
          perkModsAt: now,
          // Which loadout produced them. The agent reads it from the PlayerState the game passed in;
          // the save is only a fallback because it lags a perk swap by a battle, which once labelled
          // Reckless Abandon's numbers as belonging to the previous loadout.
          perkModsIds: (Array.isArray(msg.ids) ? (msg.ids as number[]) : (this.save?.state.equippedPerkIds ?? [])).filter((id) => id > 0),
        };
        break;
      case 'agent_error':
        this.live.detail = `erro no agente: ${String(msg.description)}`;
        break;
      default:
        break;
    }
    this.emit('changed');
  }

  #session(): NonNullable<LiveState['session']> {
    this.live.session ??= { fights: 0, wins: 0, you: emptyTally(), them: emptyTally() };
    return this.live.session;
  }

  // ---- derived ----------------------------------------------------------------------------

  #push(e: NewEvent, source: GameEvent['source'], t = new Date().toISOString()): void {
    const event = { ...e, id: randomUUID(), t, source } as GameEvent;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit('event', event);
  }

  /**
   * Zero the counters without touching the timeline: the events stay on disk and in the history,
   * only the line the rates are measured from moves. Useful right after changing the build.
   */
  resetStats(now = Date.now()): SessionStats {
    this.sessionStart = now;
    this.emit('changed');
    return this.stats(now);
  }

  stats(now = Date.now()): SessionStats {
    const start = this.sessionStart;
    const session = this.events.filter((e) => Date.parse(e.t) >= start);
    const windowStart = Math.max(start, now - RATE_WINDOW_MS);
    const hours = Math.max((now - windowStart) / 3_600_000, 5 / 60);
    const recent = session.filter((e) => Date.parse(e.t) >= windowStart);
    const drops: SessionStats['drops'] = {};
    let lastDropAt: string | undefined;
    let battles = 0;
    let xp = 0;
    let deaths = 0;
    let pvpWins = 0;
    let pvpLosses = 0;
    for (const e of session) {
      if (e.kind === 'battle') {
        battles++;
        xp += e.xp;
      } else if (e.kind === 'death') deaths++;
      else if (e.kind === 'drop') {
        drops[e.item.rarity] = (drops[e.item.rarity] ?? 0) + 1;
        lastDropAt = e.t;
      } else if (e.kind === 'pvp' && !e.friendly) {
        if (e.won) pvpWins++;
        else pvpLosses++;
      }
    }
    const sum = (kind: GameEvent['kind'], f: (e: GameEvent) => number = () => 1) =>
      recent.filter((e) => e.kind === kind).reduce((acc, e) => acc + f(e), 0);
    return {
      startedAt: new Date(start).toISOString(),
      battles,
      xpGained: xp,
      deaths,
      drops,
      xpPerHour: Math.round(sum('battle', (e) => (e.kind === 'battle' ? e.xp : 0)) / hours),
      battlesPerHour: Math.round(sum('battle') / hours),
      dropsPerHour: Math.round((sum('drop', (e) => (e.kind === 'drop' && e.item.grantSource === 'CombatDrop' ? 1 : 0)) / hours) * 10) / 10,
      ...(lastDropAt ? { lastDropAt } : {}),
      pvpWins,
      pvpLosses,
    };
  }

  /**
   * The save with the equipment the tap reads live laid over it. The game writes the save at the end
   * of a fight, so a swap made between fights is otherwise invisible for up to half a minute — and a
   * planner that still sees the old gear keeps proposing the swap that was just made. The overlay is
   * only used while it describes the same bag: every uid must be one the save knows.
   */
  viewSave(): SaveView | null {
    const save = this.save;
    const eq = this.live.status === 'live' ? this.live.equipment : undefined;
    if (!save || !eq) return save;
    const s = save.state;
    if (eq.uids.length !== s.equippedSlots.length) return save;
    const known = new Set(s.inventory.map((i) => i.uid));
    if (!eq.uids.every((uid) => uid <= 0 || known.has(uid))) return save;
    const perks = eq.perkIds.length ? eq.perkIds : s.equippedPerkIds;
    const same = eq.uids.every((u, i) => u === s.equippedUids[i]) && perks.length === s.equippedPerkIds.length && perks.every((p, i) => p === s.equippedPerkIds[i]);
    if (same) return save;
    return { ...save, state: { ...s, equippedUids: eq.uids, equippedPerkIds: perks }, liveEquipment: true };
  }

  snapshot(): AppSnapshot {
    return {
      version: this.version,
      gameRunning: this.gameRunning,
      save: this.viewSave(),
      ...(this.saveError ? { saveError: this.saveError } : {}),
      events: this.events.slice(-300),
      stats: this.stats(),
      live: this.live,
      pvp: this.pvp,
      settings: this.settings,
      xpTable: this.xpTable,
      combat: this.combat,
      pvpScouts: this.scouts,
    };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The game's own flags for the fight, from the EnemyState the tap read at its start. */
function fightMode(foe: LiveEnemy | undefined, name: string | null, isPvP: boolean): FightMode {
  if (foe?.isBossPvp || foe?.isBifidus || bossByName(name)) return 'boss';
  if (foe?.isFriendly) return 'friendly';
  if (isPvP || foe?.isPvP) return 'pvp';
  return foe?.isArenaBoss || ARENA_NAME.test(name ?? '') ? 'arena' : 'pve';
}

/** The save's record of a fight plus what the tap saw of it. */
function mergeLive(e: BattleNew, live: CombatEnd, xpKnown: boolean): BattleNew {
  const { at: _at, xp, color, enemy, won, ...rest } = live;
  return {
    ...e,
    ...rest,
    enemy,
    enemyColor: color,
    won: e.won ?? won,
    // CombatResult.xpGained, for a level-up the diff could not split
    xp: xpKnown ? e.xp : xp,
    // the save knows a sector fight from PvP too; the tap's flags tell the kinds of PvP apart
    mode: live.mode,
    ...(live.bossIndex === undefined && e.bossIndex !== undefined ? { bossIndex: e.bossIndex } : {}),
  };
}

const element = (v: unknown): LiveEnemy['resist'] => (typeof v === 'number' ? (ELEMENTS[v] ?? null) : null);

function toEnemy(e: Record<string, unknown>): LiveEnemy {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    name: (e.name as string) ?? null,
    color: ENEMY_COLORS[Number(e.color)] ?? null,
    level: Number(e.level),
    maxHp: Number(e.maxHp),
    hp: Number(e.hp || e.maxHp),
    xpWin: Number(e.xpWin),
    dropChance: Number(e.dropChance),
    isPvP: Boolean(e.isPvP),
    ...(typeof e.isFriendly === 'boolean' ? { isFriendly: e.isFriendly } : {}),
    ...(typeof e.isBossPvp === 'boolean' ? { isBossPvp: e.isBossPvp, bossPvpIndex: Number(e.bossPvpIndex ?? -1) } : {}),
    ...(typeof e.isBifidus === 'boolean' ? { isBifidus: e.isBifidus } : {}),
    ...(typeof e.isArenaBoss === 'boolean' ? { isArenaBoss: e.isArenaBoss } : {}),
    atk: num(e.atk),
    def: num(e.def),
    crit: num(e.crit),
    parry: num(e.parry),
    resist: element(e.resist),
    resist2: element(e.resist2),
    weak: element(e.weak),
  };
}

