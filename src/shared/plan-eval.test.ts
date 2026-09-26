import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import consumables from '../../game-data/consumables.json';
import enemies from '../../game-data/enemies.json';
import items from '../../game-data/items.json';
import sectors from '../../game-data/sectors.json';
import { sectorCategories, type EnemyCategory, type SectorInfo } from './combat';
import type { Consumable } from './consumables';
import type { CatalogItem, SaveState } from './contracts';
import { equippedItems, estimateBuild, inventoryCapForLevel, PER_POINT, synergyBonus } from './game-math';
import { NO_POINTS, catalogAsItem, evaluatePlan, isCatalogItem, planKey, type PlanBuild, type PlanSettings } from './plan-eval';

const STATE = JSON.parse(JSON.parse(readFileSync(join(__dirname, '../../fixtures/saves/plain-battle.before.json'), 'utf8')).payload) as SaveState;
const SECTOR = (sectors as unknown as SectorInfo[])[STATE.currentSector]!;
const SETTINGS: PlanSettings = { sector: SECTOR, cats: sectorCategories(SECTOR, enemies as unknown as EnemyCategory[]), perkWeights: {}, runs: 200, startIndex: 0, startHp: null, oddsFights: 40 };
const CATALOG = items as CatalogItem[];
const equipped = () => equippedItems(STATE).flatMap((e) => (e.item ? [e.item] : []));
const build = (patch: Partial<PlanBuild> = {}): PlanBuild => ({ items: equipped(), perkIds: [], points: NO_POINTS, potions: [], ...patch });

describe('evaluatePlan', () => {
  const base = evaluatePlan(STATE, build(), SETTINGS);

  it('measures the equipped build the way the build estimate does', () => {
    expect(base.build.stats).toEqual(estimateBuild(STATE, equipped(), { mods: {}, weight: 0 }).stats);
    expect(base.survival).toHaveLength(SECTOR.totalEnemies);
    expect(base.odds.length).toBeGreaterThan(5);
  });

  it('puts what-if points through the allocation, so stats and PWR both move', () => {
    const more = evaluatePlan(STATE, build({ points: { ...NO_POINTS, atk: 10 } }), SETTINGS);
    expect(more.build.stats.atk - base.build.stats.atk).toBeCloseTo(10 * PER_POINT.atk, 5);
    expect(more.power).toBeGreaterThan(base.power);
  });

  it('adds a potion on top of the fight profile and pays its XP bonus', () => {
    const potions = consumables as Consumable[];
    const atk = potions.find((c) => (c.mods.atkPct ?? 0) > 0)!;
    const withAtk = evaluatePlan(STATE, build({ potions: [atk] }), SETTINGS);
    expect(withAtk.fight.atk).toBeCloseTo(base.fight.atk * (1 + atk.mods.atkPct!), 5);
    expect(withAtk.build.stats.atk).toBe(base.build.stats.atk); // the build itself is untouched
    const xp = potions.find((c) => (c.mods.xpBonusPct ?? 0) > 0);
    if (xp) {
      const withXp = evaluatePlan(STATE, build({ potions: [xp] }), SETTINGS);
      expect(withXp.run.xpPerHour).toBeCloseTo(base.run.xpPerHour * (1 + xp.mods.xpBonusPct!), 3);
    }
  });

  it('keys equal plans equally and different ones differently', () => {
    expect(planKey(STATE, build(), SETTINGS)).toBe(planKey(STATE, build(), SETTINGS));
    expect(planKey(STATE, build({ points: { ...NO_POINTS, def: 5 } }), SETTINGS)).not.toBe(planKey(STATE, build(), SETTINGS));
  });
});

describe('catalogAsItem', () => {
  it('is the same piece as a copy in the bag', () => {
    const owned = STATE.inventory[0]!;
    const c = CATALOG.find((x) => x.id === owned.templateId)!;
    const made = catalogAsItem(c);
    expect(isCatalogItem(made)).toBe(true);
    for (const k of ['slot', 'rarity', 'category', 'hp', 'atk', 'def', 'crit', 'parry', 'effects'] as const) expect(made[k]).toEqual(owned[k]);
  });

  it('gives two copies in two slots different uids, so each counts the other for synergies', () => {
    const axe = CATALOG.find((x) => x.name === 'Flaming Axe')!;
    const pair = [catalogAsItem(axe, 3), catalogAsItem(axe, 4)];
    expect(pair[0]!.uid).not.toBe(pair[1]!.uid);
    // "For every other Flame item: +3 ATK" ×1.3, truncated: each sees one other Flame item
    expect(synergyBonus(pair).bonus.atk).toBe(2 * Math.trunc(3 * 1.3));
  });
});

describe('inventoryCapForLevel (GameConstants.InventoryCapForLevel)', () => {
  it('grows with the character', () => {
    expect(inventoryCapForLevel(1)).toBe(150);
    expect(inventoryCapForLevel(29)).toBe(150);
    expect(inventoryCapForLevel(30)).toBe(200);
    expect(inventoryCapForLevel(59)).toBe(200);
    expect(inventoryCapForLevel(60)).toBe(300);
  });
});
