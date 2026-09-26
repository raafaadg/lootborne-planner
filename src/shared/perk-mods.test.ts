/**
 * Every perk number pinned to what the game does, as decoded from GameAssembly.dll by
 * spikes/s8_perks.py (PerkCombat.ApplyPerk) and from PerkEconomy's combat-text table. Balance
 * version 2 — the one the live tap saw the game running on 2026-09-23.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseProcs } from './item-effects';
import {
  PERK_COMBAT_TEXT_V2,
  PERK_EFFECTS,
  loadoutCombatTexts,
  mergePerkCombat,
  mergePerkProcs,
  mergePerkStats,
  perkModelStatus,
  setLivePerkTexts,
} from './perk-mods';

afterEach(() => setLivePerkTexts(null));

describe('ApplyPerk (modifier perks), version 2', () => {
  it('matches the decoded switch', () => {
    expect(mergePerkStats([4])).toMatchObject({ defToAtkPct: 0.2 }); // Brute's Temper
    expect(mergePerkStats([9])).toMatchObject({ atkPct: 0.4, maxHpPct: -0.15 }); // Bottled Lightning: HP − V(0.25, 0.15)
    expect(mergePerkStats([10])).toMatchObject({ defPct: 0.35, maxHpPct: 0.15, atkPct: -0.12 }); // Dragonhide: ATK − V(0.25, 0.12)
    expect(mergePerkStats([15])).toMatchObject({ atkFlat: 6 });
    expect(mergePerkStats([27])).toMatchObject({ critFlat: 15 }); // Critical Apex: + V(0, 15)
    expect(mergePerkCombat([27])).toMatchObject({ critCap: 75 }); // cap V(65, 75)
    expect(mergePerkCombat([13])).toMatchObject({ damageDealtMult: 1.3, damageTakenMult: 1.1 }); // V(1.2, 1.3), ×1.1
    expect(mergePerkCombat([18])).toMatchObject({ tenacityLifestealPct: 0.05 }); // V(0.03, 0.05)
    expect(mergePerkCombat([21])).toMatchObject({ damageDealtMult: 1.5, disableHealing: true }); // V(1.35, 1.5)
    expect(mergePerkCombat([22])).toMatchObject({ damageDealtMult: 2, damageTakenMult: 1.25 }); // taken V(1.5, 1.25)
    expect(mergePerkCombat([23])).toMatchObject({ tenacityLifestealPct: 0.13 }); // Blood Curse lifesteal V(0.15, 0.13)
    expect(mergePerkProcs([23]).drainPctOfDamageDealt).toBeCloseTo(0.11); // V(0, 0.11)
    expect(mergePerkCombat([12])).toMatchObject({ flatHealPerHit: 3 });
    expect(mergePerkCombat([2])).toMatchObject({ parryFloor: 15 });
  });

  it('multiplies stacked damage perks, as ApplyPerk does', () => {
    expect(mergePerkCombat([13, 22]).damageDealtMult).toBeCloseTo(2.6);
    expect(mergePerkCombat([13, 22]).damageTakenMult).toBeCloseTo(1.375);
  });

  it('reads the flag perks with their combat-code constants', () => {
    // Rising Momentum: damage × (1 + stacks × V(0.05, 0.04)), 10 stacks, landed hits only
    expect(PERK_EFFECTS[5]!.procs!.risingDamage).toEqual({ step: 0.04, max: 0.4 });
    // Pent-Up Wrath: +10 CRIT per non-crit landed hit, up to 50, reset on a crit
    expect(PERK_EFFECTS[1]!.procs!.stackingCrit).toEqual({ step: 0.1, max: 0.5 });
  });
});

describe('text perks', () => {
  it('parse from the combat text the fight uses, not the description', () => {
    const p = (id: number) => mergePerkProcs([id]);
    expect(p(6).everyNAttacks).toEqual([expect.objectContaining({ n: 3, damagePct: 1.4, ignoreParry: true })]);
    expect(p(25).everyNAttacks).toEqual([expect.objectContaining({ n: 5, damagePct: 1.2, ignoreParry: true })]);
    expect(p(7).critPoison).toEqual({ damage: 28, seconds: 4 });
    expect(p(8).onParry?.damageNextPct).toBeCloseTo(0.35);
    expect(p(8).riposteHits).toBe(2); // "next 2 attacks": we used to model one
    expect(p(11).belowHp).toEqual([expect.objectContaining({ pct: 0.4, atkPct: 0.8 })]);
    expect(p(19).reflectPct).toBeCloseTo(0.5);
    expect(p(23).overhealShield).toBe(true);
    expect(p(31).ignoreParryPct).toBeCloseTo(0.35);
    expect(p(31).ignoreDefPct).toBeCloseTo(0.35);
  });

  it("reads Bulwark's 8 HP per second, not the 4 its description shows", () => {
    const b = mergePerkProcs([28]).belowHp![0]!;
    expect(b.pct).toBe(0.25);
    expect(b.absorbPct).toBeCloseTo(0.42);
    expect(b.regenPerSec).toBe(8);
  });

  it('prefers the texts the live tap read from the game', () => {
    setLivePerkTexts({ 28: 'Below 25% HP: absorb 42% damage and regenerates 4 HP/sec' });
    expect(mergePerkProcs([28]).belowHp![0]!.regenPerSec).toBe(4);
    // an empty live text means the perk has none, whatever the table says
    setLivePerkTexts({ 19: '' });
    expect(mergePerkProcs([19]).reflectPct ?? 0).toBe(0);
  });
});

describe('Mirror Echo', () => {
  it('feeds the left perk\'s combat text a second time', () => {
    expect(mergePerkProcs([19, 26]).reflectPct).toBeCloseTo(1); // KISA: 564 of 564 reflected
    expect(mergePerkProcs([6, 26]).everyNAttacks).toHaveLength(2);
    expect(loadoutCombatTexts([19, 26])).toEqual([PERK_COMBAT_TEXT_V2[19], PERK_COMBAT_TEXT_V2[19]]);
  });

  it('copies nothing from a perk whose mechanic is not text (ApplyPerk applies each id once)', () => {
    expect(mergePerkProcs([5, 26]).risingDamage).toEqual({ step: 0.04, max: 0.4 });
    expect(mergePerkProcs([13, 26])).toEqual(mergePerkProcs([13]));
    expect(mergePerkCombat([13, 26]).damageDealtMult).toBeCloseTo(1.3);
  });

  it('does nothing in the first slot or next to nothing', () => {
    expect(mergePerkProcs([26, 19]).reflectPct).toBeCloseTo(0.5);
  });
});

describe('perkModelStatus', () => {
  it('tells how each perk is modelled', () => {
    expect(perkModelStatus(5).kind).toBe('modifiers');
    expect(perkModelStatus(28)).toEqual({ kind: 'text', text: PERK_COMBAT_TEXT_V2[28] });
    expect(perkModelStatus(29).kind).toBe('partial');
    expect(perkModelStatus(99).kind).toBe('unknown'); // a perk from a future update
  });

  it('knows every perk the catalog has', () => {
    for (let id = 1; id <= 31; id++) expect(perkModelStatus(id).kind).not.toBe('unknown');
  });
});

describe('below-HP regeneration, read the way the game reads it', () => {
  const regen = (t: string) => parseProcs([t]).belowHp[0]!;
  it('treats a bare "regenerates N HP" as per second', () => {
    expect(regen('Below 30% HP: regenerates 5 HP').regenPerSec).toBe(5);
    expect(regen('Below 30% HP: +30% DEF and regenerates 4 HP/sec').regenPerSec).toBe(4);
  });
  it('keeps the per-attack forms per attack', () => {
    const r = regen('Below 30% HP: ogni attacco regenerates 4 HP');
    expect(r.regenPerAttack).toBe(4);
    expect(r.regenPerSec).toBe(0);
  });
});
