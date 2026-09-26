// Types shared by main, preload and renderer.

export const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Ascended'] as const;
export type Rarity = (typeof RARITIES)[number];

export const SCREENS = ['Creation', 'Home', 'Equip', 'Inventory', 'Battle'] as const;
export type GameScreen = (typeof SCREENS)[number];

export const ENEMY_COLORS = ['Grigio', 'Blu', 'Viola'] as const;
export type EnemyColor = (typeof ENEMY_COLORS)[number];

export const ELEMENTS = ['Nessuna', 'Arcane', 'Flame', 'Frost', 'Holy', 'Shadow'] as const;
export type Element = (typeof ELEMENTS)[number];

/** `slot` index used by save items (ItemInstance.slot). */
export const ITEM_SLOTS = ['Testa', 'Corpo', 'Cintura', 'Arma', 'Anello', 'Trinket'] as const;

/** GrantSource enum (AutoBattle.Inventory.GrantSource). */
export const GRANT_SOURCES = [
  'Unknown', 'CombatDrop', 'LevelUp', 'SectorClear', 'ArenaMilestone', 'Forge', 'Starter',
  'Compensation', 'Other', 'Debug', 'ArenaBoss', 'ArenaReclear',
] as const;

/** One item as stored in the save payload (`inventory[]`). */
export interface SaveItem {
  uid: number;
  templateId: number;
  itemName: string;
  slot: number;
  rarity: number;
  category: number;
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
  effects: string[];
  isNew: boolean;
  locked: boolean;
  isBossExclusive: boolean;
  grantSource: number;
}

/** The fields of the save payload the Planner reads. The payload has ~110 keys; the rest pass through untyped. */
export interface SaveState {
  name: string;
  characterType: number;
  level: number;
  xp: number;
  stamina: number;
  currentSector: number;
  sectorEnemy: number;
  sectorCleared: boolean[];
  currentHp: number;
  inventory: SaveItem[];
  equippedSlots: string[];
  equippedUids: number[];
  battleActive: boolean;
  totalBattleTime: number;
  sector0DropCount: number;
  killsWithoutDrop: number;
  /** the Arena (endless waves), open once every sector is cleared */
  endlessMode: boolean;
  waveIndex: number;
  /** kills made in the current wave (10 per wave) */
  waveKillCount?: number;
  maxWaveRecord: number;
  /** Arena bosses beaten, one bit per boss (every 10 waves) */
  arenaBossDefeatedMask?: number;
  unspentStatPoints: number;
  /** respecs done so far: ShopSystem.GetRespecCost is free while this is 0, then RESPEC_FLAT_COST */
  respecCount?: number;
  allocatedHp: number;
  allocatedAtk: number;
  allocatedDef: number;
  allocatedCrit: number;
  allocatedParry: number;
  pvpCurrency: number;
  equippedPerkIds: number[];
  ownedPerkIds: number[];
  deathsInSectorPersistent: number;
  fightsInSectorPersistent: number;
  vigorHoursRemaining: number;
  /** potions running right now, and how many seconds each has left */
  activeConsumableIds: number[];
  activeConsumableRemaining: number[];
  ownedConsumableIds: number[];
  ownedConsumableCounts: number[];
  muratoActionMask: number;
  muratoBattlesSinceProgress: number;
  muratoBattlesSinceAction: number;
  /** BossPvpEncounter: normal PvP matches since the last boss, and whether one has ever appeared */
  bossPvpCounter?: number;
  bossPvpFirstSeen?: boolean;
  [key: string]: unknown;
}

export interface CatalogItem {
  id: number;
  name: string;
  slot: string;
  rarity: Rarity;
  element: Element;
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
  isMelee: boolean;
  isBossExclusive: boolean;
  effects: string[];
}

export interface CatalogSector {
  id: number;
  name: string;
  totalEnemies: number;
  resist: Element;
  weak: Element;
  dropPct: Record<'common' | 'rare' | 'epic' | 'legendary' | 'mythic', number>;
  clearRewardRarity: Rarity;
  levelUpRarityCap: Rarity;
}

export interface ItemRef {
  uid: number;
  templateId: number;
  name: string;
  slot: number;
  rarity: Rarity;
  grantSource?: string;
}

export interface LiveEnemy {
  name: string | null;
  color: EnemyColor | null;
  level: number;
  maxHp: number;
  hp: number;
  xpWin: number;
  dropChance: number;
  isPvP: boolean;
  /** EnemyState flags for the special PvP fights (read by name; absent on older agents) */
  isFriendly?: boolean;
  isBossPvp?: boolean;
  bossPvpIndex?: number;
  isBifidus?: boolean;
  isArenaBoss?: boolean;
  /** EnemyState as the game filled it: exact, perks of a PvP opponent already applied. */
  atk?: number;
  def?: number;
  crit?: number;
  parry?: number;
  resist?: Element | null;
  resist2?: Element | null;
  weak?: Element | null;
}

/** A PvP opponent we met while the live tap was on: their real EnemyState, not an estimate. */
export interface PvpScouted {
  name: string;
  at: string;
  level: number;
  maxHp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
  /**
   * From PlayFabManager.SnapshotToEnemyState(PlayerSnapshot), which is the only place these exist:
   * ReplayFighter stores just name/level/characterType/maxHp/gear/badge, so a fight we only have the
   * replay for can never show them.
   */
  perkIds?: number[];
  power?: number;
  rankingPoints?: number;
  mmr?: number;
  matches?: number;
}

/**
 * What kind of fight a battle was. The autofight loop mixes them: sector fights (PvE), a ranked PvP
 * match every few minutes, and every 10th PvP match one of the four PvP bosses (BossPvpEncounter).
 * `other` is XP that did not come from a fight (the progress the game credits after a restart).
 */
export type FightMode = 'pve' | 'arena' | 'pvp' | 'boss' | 'friendly' | 'other';

/** The enemy's EnemyState at the start of a fight, as the live tap read it. */
export interface FightEnemyStats {
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
}

interface EventBase {
  id: string;
  /** ISO timestamp */
  t: string;
  source: 'save' | 'live' | 'replay';
}

export type GameEvent = EventBase &
  (
    | {
        kind: 'battle';
        xp: number;
        hp: [number, number];
        stamina: [number, number];
        sector: number;
        enemyIndex: number;
        pity: number;
        /** Filled from the live tap when it saw the same fight. */
        enemy?: string | null;
        enemyColor?: EnemyColor | null;
        won?: boolean;
        /** live tap when it saw the fight, else what changed in the save (PvE advances the sector) */
        mode?: FightMode;
        /** BossPvpEncounter index (0..3) when mode is 'boss' */
        bossIndex?: number;
        /** Arena: the wave of the fight and which of its kills it was (1-based) */
        wave?: number;
        waveKill?: number;
        arenaBoss?: boolean;
        enemyLevel?: number;
        /** combat start → end as the live tap timed it (wall clock) */
        durationMs?: number;
        /** attacks both sides made, and what each side did (live tap) */
        turns?: number;
        you?: SideTally;
        them?: SideTally;
        enemyStats?: FightEnemyStats;
        /** ranking points the fight moved (PvP) */
        rpDelta?: number;
      }
    | { kind: 'level_up'; from: number; to: number; unspent: number }
    | { kind: 'drop'; item: ItemRef }
    | { kind: 'item_removed'; items: ItemRef[] }
    | { kind: 'death'; sector: number; deathsInSector: number }
    | { kind: 'sector_change'; from: number; to: number; cleared: boolean }
    | { kind: 'battle_paused'; hp: number; stamina: number }
    | { kind: 'battle_resumed'; hp: number; stamina: number }
    | { kind: 'pvp'; won: boolean; friendly: boolean; opponent: string; opponentLevel: number; turns: number; currencyDelta?: number }
    | { kind: 'autofight'; on: boolean; fromPlayer: boolean; reason?: 'stamina' }
    | { kind: 'stat_points'; unspent: number }
  );

export type GameEventKind = GameEvent['kind'];

/** One equipped piece as the replay records it (ReplayFighter.equippedItems). */
export interface PvpGear {
  slot: string;
  name: string;
  rarity: Rarity;
  element: Element;
}

/** ReplayFighter: everything the game stores about one side of a PvP fight. */
export interface PvpFighter {
  name: string;
  level: number;
  characterType: number;
  maxHp: number;
  badgeId: string;
  gear: PvpGear[];
}

/** The part of a turn that counts towards a tally; shared by replays and the live tap. */
export interface TurnCounts {
  playerAttacking: boolean;
  damage: number;
  crit: boolean;
  parried: boolean;
  /** heal each side got this turn (perk or item effect) */
  healPlayer: number;
  healEnemy: number;
  /** counter-attack damage each side dealt back this turn */
  counterPlayer: number;
  counterEnemy: number;
}

/** ReplayTurn, with the heal/counter/sudden-death fields the first version dropped. */
export interface PvpTurn extends TurnCounts {
  suddenDeath: boolean;
  hpPlayer: number;
  hpEnemy: number;
}

/** What one side did over a fight. `parried` counts the attacks the *other* side parried. */
export interface SideTally {
  attacks: number;
  landed: number;
  crits: number;
  parried: number;
  damage: number;
  best: number;
  heal: number;
  counter: number;
}

export function emptyTally(): SideTally {
  return { attacks: 0, landed: 0, crits: 0, parried: 0, damage: 0, best: 0, heal: 0, counter: 0 };
}

/** Adds one turn to both sides' tallies. Shared by replays, the live tap and simulated duels. */
export function applyTurn(you: SideTally, them: SideTally, t: TurnCounts): void {
  const side = t.playerAttacking ? you : them;
  side.attacks++;
  if (t.parried) side.parried++;
  else {
    side.landed++;
    side.damage += t.damage;
    side.best = Math.max(side.best, t.damage);
    if (t.crit) side.crits++;
  }
  you.heal += t.healPlayer;
  them.heal += t.healEnemy;
  you.counter += t.counterPlayer;
  them.counter += t.counterEnemy;
}

export function tally(turns: TurnCounts[]): { you: SideTally; them: SideTally } {
  const you = emptyTally();
  const them = emptyTally();
  for (const t of turns) applyTurn(you, them, t);
  return { you, them };
}

export interface PvpReplay {
  file: string;
  t: string;
  won: boolean;
  friendly: boolean;
  suddenDeath: boolean;
  player: PvpFighter;
  opponent: PvpFighter;
  turns: number;
  you: SideTally;
  them: SideTally;
  /** Only in the detail fetched on demand; the history list carries summaries. */
  log?: PvpTurn[];
}

/** One resolved turn as the live tap sees it (CombatTurnResult). */
export interface LiveTurn extends TurnCounts {
  n: number;
  playerHp: number;
  enemyHp: number;
  at: string;
}

/** The fight on screen right now, or the one that just ended. */
export interface LiveFight {
  startedAt: string;
  endedAt?: string;
  enemy?: LiveEnemy;
  turns: LiveTurn[];
  you: SideTally;
  them: SideTally;
  won?: boolean;
}

export type LiveStatus = 'off' | 'waiting' | 'attaching' | 'live' | 'error' | 'unavailable';

export interface LiveState {
  status: LiveStatus;
  detail?: string;
  pid?: number;
  since?: string;
  lastMessageAt?: string;
  screen?: GameScreen;
  inCombat: boolean;
  enemy?: LiveEnemy;
  player?: { hp: number; stamina: number; level: number; xp: number; battleActive: boolean };
  /** PlayerState.equippedUids / equippedPerkIds as the tap last read them */
  equipment?: { uids: number[]; perkIds: number[]; at: string };
  lastTurn?: { playerAttacking: boolean; damage: number; crit: boolean; parried: boolean; at: string };
  /** Turn-by-turn log of the current (or last) fight. */
  fight?: LiveFight;
  /** Everything counted since the tap attached. */
  session?: { fights: number; wins: number; you: SideTally; them: SideTally };
  autofight?: { on: boolean; fromPlayer: boolean; at: string; reason?: 'stamina' };
  power?: number;
  hooks?: { ok: string[]; failed: string[] };
}

export interface CombatStats {
  hp: number;
  atk: number;
  def: number;
  crit: number;
  parry: number;
}

/** What the live tap learned about combat; cached on disk so the advisor works without the tap. */
export interface CombatKnowledge {
  /** StatsCalculator.GetTotalStats for our player (perks and synergies included). */
  stats?: CombatStats;
  statsAt?: string;
  /** PerkCombat.GetPerkModifiers for our player in PvE. */
  perkMods?: Record<string, number | boolean>;
  perkModsAt?: string;
  /** the perk loadout those modifiers describe; they go stale the moment it changes */
  perkModsIds?: number[];
  /** GameConstants.REGEN_BASELINE_PCT_BY_SECTOR */
  regenPct?: number[];
  /** GameConstants.ENEMY_WEAK_BOTH_WEAPONS_PCT */
  weakBothPct?: number;
  /** PerkData.psWeight by perk id: what GetPowerScore(stats, state) adds per equipped perk. */
  perkWeights?: Record<number, number>;
  /**
   * PerkData.combatEffect by perk id, read from the running game: the text the fight actually parses
   * for text-driven perks ('' for perks whose mechanic lives in PerkCombat.ApplyPerk).
   */
  perkTexts?: Record<number, string>;
  /** PerkData.tier by perk id (0 bronze, 1 silver, 2 gold) */
  perkTiers?: Record<number, number>;
  /** PerkEconomy.IsV2: which perk balance version the game runs; our table is written for v2 */
  perkEconomyV2?: boolean;
  perkEconomyAt?: string;
}

export interface SessionStats {
  startedAt: string;
  battles: number;
  xpGained: number;
  deaths: number;
  drops: Partial<Record<Rarity, number>>;
  xpPerHour: number;
  battlesPerHour: number;
  dropsPerHour: number;
  lastDropAt?: string;
  pvpWins: number;
  pvpLosses: number;
}

export interface NotifySettings {
  enabled: boolean;
  dropMinRarity: Rarity;
  levelUp: boolean;
  deathStreak: number;
  battleStalledSeconds: number;
  inventoryNearCap: boolean;
  discordWebhook: string;
}

export interface Settings {
  live: { enabled: boolean; consentAt?: string };
  notify: NotifySettings;
  /** page zoom (1 = 100%): makes every font and control bigger at once */
  ui: { zoom: number };
}

export interface SaveView {
  state: SaveState;
  path: string;
  writtenAt: string;
  sigVersion: number | null;
  /**
   * The equipped items and perks in `state` were read live from the game, not from the save: a
   * swap made in the game shows at once instead of after the next fight.
   */
  liveEquipment?: boolean;
}

export interface AppSnapshot {
  version: string;
  gameRunning: boolean;
  save: SaveView | null;
  saveError?: string;
  events: GameEvent[];
  stats: SessionStats;
  live: LiveState;
  pvp: PvpReplay[];
  settings: Settings;
  xpTable: Record<number, number>;
  combat: CombatKnowledge;
  /** PvP opponents scouted live, by name. */
  pvpScouts: Record<string, PvpScouted>;
}

export interface PlannerApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  /** Zero the session counters (XP, fights, drops, deaths, PvP). The timeline keeps everything. */
  resetStats(): Promise<SessionStats>;
  /** Every archived fight (summaries, newest first); the snapshot only carries the recent ones. */
  pvpHistory(): Promise<PvpReplay[]>;
  /** Full replay (with the turn log) from our own archive. */
  pvpDetail(file: string): Promise<PvpReplay | null>;
  /** Fight-related events from the history on disk (the snapshot only carries the last 300 events). */
  battleHistory(limit: number): Promise<GameEvent[]>;
  /**
   * The most recent opponents as fighters the duel simulator can replay (pvp-arena.ts), for the
   * PvP goal of the build optimiser. Typed loosely here to keep contracts free of the sim types.
   */
  pvpArena(limit: number): Promise<unknown[]>;
  testNotification(): Promise<void>;
  openDataFolder(): Promise<void>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
