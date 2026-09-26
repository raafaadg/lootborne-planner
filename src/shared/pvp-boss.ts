/**
 * The PvP bosses as duel opponents, so a build can be scored on beating one.
 *
 * What the game puts into a boss fight (BossPvpEncounter.Build, decoded from the ISIL):
 * - the EnemyState stats of PVP_BOSSES (fixed per boss, read live);
 * - a fixed loadout (BuildLoadout(i)) of real catalog items, whose effects fight like any
 *   opponent's gear; no perks (pvpEquippedPerkIds is never filled);
 * - pvpWeaponElement, resistElement and weakElement. CombatManager.ResolveAttack runs the element
 *   block when `!enemy.isPvP || enemy.isBossPvp`, so against a boss your weapons' elements count
 *   exactly as they do against a sector monster (resisted −15% per weapon, weak +15%, both weapons
 *   weak = ENEMY_WEAK_BOTH_WEAPONS_PCT). Everything else is the PvP duel: sudden death, Rival's
 *   Calling, no PvE-only perks, no potions.
 */
import catalog from '../../game-data/items.json';
import type { ElementName } from './combat';
import type { CatalogItem, Element, PvpFighter } from './contracts';
import { PVP_BOSSES, type PvpBoss } from './battles';
import { fighterItems } from './pvp-analysis';
import { fighterModel, type FighterModel } from './pvp-opponent';

/** BuildLoadout(i), slot by slot. */
export const BOSS_LOADOUTS: Record<number, Array<[slot: string, name: string]>> = {
  0: [['Arma 1', 'Ice Mace'], ['Arma 2', 'Frost Shield'], ['Testa', 'Frost Helm'], ['Corpo', 'Glacial Cuirass'], ['Cintura', 'Winter Sash'], ['Anello 1', 'Frost Ring'], ['Trinket', 'Ice Crystal']],
  1: [['Arma 1', 'Shadow Stiletto'], ['Arma 2', 'Eclipse Twinblade'], ['Testa', 'Shadowfang Helm'], ['Corpo', "Assassin's Tunic"], ['Cintura', 'Belt of Whispers'], ['Anello 1', 'Dark Void Ring'], ['Trinket', 'Twilight Essence']],
  2: [['Arma 1', 'Blade of Redemption'], ['Arma 2', "Frirekr Toto's Aegis"], ['Testa', "Fallen Angel's Veil"], ['Corpo', 'Vestment of the Unbroken Light'], ['Cintura', 'Sunward Cincture'], ['Anello 1', 'Miracle Ring'], ['Trinket', 'Dawnguard Pendant']],
  3: [['Arma 1', "Sylvia's Sickle"], ['Arma 2', 'Greatsword of Eternal Fire'], ['Testa', "Brenna Mann's Helm"], ['Corpo', 'Fire Titan Cuirass'], ['Cintura', 'Cinderfall Chain'], ['Anello 1', 'Supernova Ring'], ['Trinket', 'Heart of the Sun']],
};

const BY_NAME = new Map((catalog as CatalogItem[]).map((c) => [c.name, c]));

/** The boss as the duel simulator's opponent, with its element pair for the damage we deal it. */
export function bossModel(boss: PvpBoss): FighterModel {
  const gear = (BOSS_LOADOUTS[boss.index] ?? []).map(([slot, name]) => {
    const c = BY_NAME.get(name);
    return { slot, name, rarity: c?.rarity ?? 'Common', element: (c?.element ?? 'Nessuna') as Element };
  });
  const fighter: PvpFighter = { name: boss.name, level: boss.level, characterType: 0, maxHp: boss.stats.hp, badgeId: '', gear };
  const model = fighterModel(fighter, fighterItems(fighter, BY_NAME), { ...boss.stats }, [], 'jogo', 'jogo', [`equipamento do boss: ${gear.map((g) => g.name).join(', ')}`]);
  return {
    ...model,
    elements: {
      ...(boss.resist ? { resist: boss.resist as ElementName } : {}),
      ...(boss.weak ? { weak: boss.weak as ElementName } : {}),
    },
  };
}

/** The boss of the level band, or null below the first one. */
export function bossForLevel(level: number): PvpBoss | null {
  let out: PvpBoss | null = null;
  for (const b of PVP_BOSSES) if (level >= b.level) out = b;
  return out;
}
