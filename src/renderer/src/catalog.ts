import type { CatalogItem, CatalogSector } from '@shared/contracts';
import items from '../../../game-data/items.json';
import sectors from '../../../game-data/sectors.json';
import type { EnemyCategory, SectorInfo } from '@shared/combat';
import enemies from '../../../game-data/enemies.json';
import perks from '../../../game-data/perks.json';
import consumables from '../../../game-data/consumables.json';
import type { Consumable } from '@shared/consumables';

/** Extracted from sharedassets0.assets by spikes/s5_catalog.py (build c4889dfe). */
export const CATALOG_ITEMS = items as CatalogItem[];
export const CATALOG_SECTORS = sectors as CatalogSector[];

const byId = new Map(CATALOG_ITEMS.map((i) => [i.id, i]));

export function catalogItem(templateId: number): CatalogItem | undefined {
  return byId.get(templateId);
}

export function sector(index: number): CatalogSector | undefined {
  return CATALOG_SECTORS[index];
}


/** EnemyCategoryData (variants with the exact stats the game copies into EnemyState). */
export const ENEMY_CATEGORIES = enemies as unknown as EnemyCategory[];

export interface PerkInfo {
  id: number;
  name: string;
  effect: string;
  nameEn: string;
  effectEn: string;
  /** PerkData.psWeight: what this perk adds to the game's PWR, on top of the stats. */
  psWeight: number;
  tier: number;
  cost: number;
}
/** Names and effect texts from the game's pt-BR / en localization. */
export const PERKS = perks as PerkInfo[];

export function sectorInfo(index: number): SectorInfo | undefined {
  return CATALOG_SECTORS[index] as unknown as SectorInfo | undefined;
}

/**
 * ConsumableCatalog.All read from the running game, with the exact modifiers decoded from
 * ConsumableSystem.GetActiveModifiers (spikes/s6_consumables.py).
 */
export const CONSUMABLES = consumables as Consumable[];

export function consumable(id: number): Consumable | undefined {
  return CONSUMABLES.find((c) => c.id === id);
}
