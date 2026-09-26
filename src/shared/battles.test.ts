import { describe, expect, it } from 'vitest';
import { PVP_BOSSES, bossForecast, bossRecords, classifyBattles, pvpInterval, summarize, TRANSITION_MS } from './battles';
import type { GameEvent, PvpReplay, SaveState } from './contracts';
import { emptyTally } from './contracts';

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 23, 17, 0, 0) + s * 1000).toISOString();
function battle(s: number, patch: Partial<Extract<GameEvent, { kind: 'battle' }>> = {}): GameEvent {
  return { kind: 'battle', id: `b${n++}`, t: at(s), source: 'save', xp: 31_154, hp: [400, 380], stamina: [50, 49.36], sector: 5, enemyIndex: 3, pity: 1, ...patch };
}
function replay(s: number, opponent: string, won: boolean): PvpReplay {
  const fighter = { name: opponent, level: 47, characterType: 0, maxHp: 670, badgeId: '', gear: [] };
  return { file: `${opponent}.json`, t: at(s), won, friendly: false, suddenDeath: false, player: { ...fighter, name: 'CatNation' }, opponent: fighter, turns: 19, you: emptyTally(), them: emptyTally() };
}

describe('classifyBattles on history written before modes were recorded', () => {
  // the 17:57 sequence of 2026-09-23: sector fights with the tap's names, a ranked match that only
  // left a nameless save event and a replay, and a boss that left neither a name nor a replay
  const events: GameEvent[] = [
    battle(0, { enemy: 'Deserter', enemyColor: 'Grigio', won: true }),
    battle(27, { enemy: 'Deserter', enemyColor: 'Blu', won: true, xp: 36_562 }),
    battle(43, { xp: 10_206, hp: [467, 467] }), // "Inimigo 3 · +10.206 XP · HP 467→467"
    battle(70, { enemy: 'Deserter', enemyColor: 'Grigio', won: true }),
    battle(89, { xp: 160, hp: [490, 319] }), // a boss: exactly Agni Pariksha's xpLose
    battle(117, { enemy: 'Deserter', enemyColor: 'Grigio', won: true }),
  ];
  const rows = classifyBattles(events, [replay(42.4, 'anthony.sa', false)]);

  it('recovers each fight kind', () => {
    expect(rows.map((r) => r.mode)).toEqual(['pve', 'pve', 'pvp', 'pve', 'boss', 'pve']);
    expect(rows[2]).toMatchObject({ enemy: 'anthony.sa', won: false, modeFrom: 'replay', turns: 19 });
    expect(rows[4]).toMatchObject({ enemy: 'Agni Pariksha', won: false, modeFrom: 'xp' });
    expect(rows[4]?.boss?.drop).toBe('Emberdoom Greatsword');
  });

  it('estimates each duration from the gap between saves, minus the transition', () => {
    expect(rows[0]?.durationMs).toBeNull(); // nothing before it
    expect(rows[1]).toMatchObject({ durationMs: 27_000 - TRANSITION_MS, durationFrom: 'gap' });
    expect(rows[2]?.durationMs).toBe(16_000 - TRANSITION_MS);
  });
});

describe('classifyBattles on new events', () => {
  it('prefers the timed duration and the mode the tap recorded', () => {
    const rows = classifyBattles([
      battle(0, { enemy: 'Deserter', mode: 'pve', won: true }),
      battle(30, { enemy: 'Glen_Duval', mode: 'pvp', won: false, xp: 10_206, durationMs: 11_770 }),
    ]);
    expect(rows[1]).toMatchObject({ mode: 'pvp', modeFrom: 'live', durationMs: 11_770, durationFrom: 'live' });
  });

  it('does not read a sector fight as a boss because its XP happens to match', () => {
    const [row] = classifyBattles([battle(0, { mode: 'pve', xp: 160 })]);
    expect(row?.mode).toBe('pve');
  });

  it('drops the copy a second instance of the app logged of the same fight', () => {
    const rows = classifyBattles([battle(0, { mode: 'pve' }), battle(25, { mode: 'pve', xp: 12_672 }), battle(25.1, { mode: 'pve', xp: 12_672 }), battle(50, { mode: 'pve' })]);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.durationMs).toBe(25_000 - TRANSITION_MS);
  });

  it('breaks the duration estimate across a pause', () => {
    const rows = classifyBattles([
      battle(0, { mode: 'pve' }),
      { kind: 'battle_paused', id: 'p', t: at(10), source: 'save', hp: 1, stamina: 0 },
      battle(200, { mode: 'pve' }),
    ]);
    expect(rows[1]?.durationMs).toBeNull();
  });

  it('joins the drops and level-up of the same save, and a death is a loss', () => {
    const t = at(30);
    const rows = classifyBattles([
      battle(0, { mode: 'pve' }),
      { ...battle(30, { mode: 'pve', won: false, xp: 0 }), t },
      { kind: 'death', id: 'd', t, source: 'save', sector: 5, deathsInSector: 3 },
      battle(60, { mode: 'pve' }),
      { kind: 'drop', id: 'x', t: at(60), source: 'save', item: { uid: 1, templateId: 45, name: 'Lesser Grimoire', slot: 3, rarity: 'Rare' } },
      { kind: 'level_up', id: 'l', t: at(60), source: 'save', from: 50, to: 51, unspent: 5 },
    ]);
    expect(rows[1]).toMatchObject({ died: true, won: false });
    expect(rows[2]?.drops.map((d) => d.name)).toEqual(['Lesser Grimoire']);
    expect(rows[2]?.levelUp).toBe(51);
  });

  it("sets the game's offline credit apart from the fights", () => {
    const rows = classifyBattles([
      ...Array.from({ length: 10 }, (_, i) => battle(i * 25, { mode: 'pve', xp: 13_784 })),
      battle(700, { xp: 674_432, hp: [316, 316], stamina: [96.8, 97.83] }),
    ]);
    expect(rows.at(-1)?.mode).toBe('other');
    expect(summarize(rows).fights).toBe(10);
  });
});

describe('summaries', () => {
  it('averages the duration and XP per kind', () => {
    const rows = classifyBattles([
      battle(0, { mode: 'pve', enemy: 'Deserter', durationMs: 20_000 }),
      battle(30, { mode: 'pve', enemy: 'Deserter', durationMs: 30_000, xp: 36_562 }),
      battle(60, { mode: 'pvp', enemy: 'Hao', won: true, durationMs: 11_000, xp: 40_825 }),
    ]);
    const pve = summarize(rows, 'pve');
    expect(pve).toMatchObject({ fights: 2, wins: 2, xp: 31_154 + 36_562 });
    expect(pve.duration.avgMs).toBe(25_000);
    expect(pve.xpPerFightMinute).toBeCloseTo((31_154 + 36_562) / (50 / 60));
    expect(summarize(rows).duration.medianMs).toBe(20_000);
  });

  it('keeps each boss record and whether its drop is owned', () => {
    const rows = classifyBattles([battle(0, { xp: 160 }), battle(600, { xp: 160 }), battle(1200, { xp: 750 })]);
    const state = { inventory: [{ templateId: 423 }] } as unknown as SaveState;
    const agni = bossRecords(rows, state)[3]!;
    expect(agni).toMatchObject({ fights: 3, wins: 1, losses: 2, defeated: false });
    expect(bossRecords(rows, state)[2]?.defeated).toBe(true);
  });

  it('measures the PvP rhythm', () => {
    const rows = classifyBattles([battle(0, { mode: 'pvp' }), battle(400, { mode: 'pvp' }), battle(820, { mode: 'boss', xp: 160 })]);
    expect(pvpInterval(rows)).toBe(410_000);
  });
});

describe('bossForecast (BossPvpEncounter.ShouldTrigger)', () => {
  const state = (patch: Partial<SaveState>) => ({ level: 51, inventory: [], bossPvpCounter: 5, bossPvpFirstSeen: true, ...patch }) as unknown as SaveState;

  it('counts the ranked matches left before the boss of the level band', () => {
    const f = bossForecast(state({}))!;
    expect(f.boss?.name).toBe('Agni Pariksha');
    expect(f.rankedBefore).toBe(4); // counter 5 → it triggers when counter + 1 ≥ 10
  });

  it('uses the first threshold of 5 before any boss', () => {
    expect(bossForecast(state({ bossPvpFirstSeen: false, bossPvpCounter: 0 }))!.rankedBefore).toBe(4);
  });

  it('sends no boss once you own its drop', () => {
    const f = bossForecast(state({ inventory: [{ templateId: PVP_BOSSES[3]!.dropId }] as SaveState['inventory'] }))!;
    expect(f.defeated).toBe(true);
    expect(f.rankedBefore).toBeNull();
  });

  it('picks the band by level', () => {
    expect(bossForecast(state({ level: 24 }))!.boss?.name).toBe("Nero d'Inferno");
    expect(bossForecast(state({ level: 4 }))!.boss).toBeNull();
  });
});
