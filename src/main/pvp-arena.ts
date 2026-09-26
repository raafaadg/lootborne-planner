import type { CatalogItem, PvpReplay } from '@shared/contracts';
import { buildArena } from '@shared/pvp-arena';
import type { FighterModel } from '@shared/pvp-opponent';
import { setLivePerkTexts } from '@shared/perk-mods';
import catalog from '../../game-data/items.json';
import type { AppState } from './app-state';
import type { PvpArchive } from './storage/pvp-archive';

const BY_NAME = new Map((catalog as CatalogItem[]).map((c) => [c.name, c]));

/** Details are re-parsed from the raw copies; keep them while the files do not change. */
const details = new Map<string, PvpReplay>();

/**
 * The opponents of the most recent ranked fights, each measured against our side in that fight.
 * Our side counts as "today's build" when its max HP matches the stats the live tap last read.
 *
 * Only the opponents the live tap read exactly (stats and perks) make a trustworthy pool: over the
 * 129 fights of 2026-09-25/26 the model expected 59.7 wins and there were 60 against those, while
 * the ones measured from the replay alone came out at ~95% predicted for fights that were lost. So
 * the pool is the latest `limit` distinct opponents read exactly, topped up with measured ones only
 * when there are not enough.
 */
export function arenaFor(state: AppState, archive: PvpArchive, limit: number): FighterModel[] {
  setLivePerkTexts(state.combat.perkTexts);
  const save = state.save?.state;
  const recent = archive.summaries().filter((r) => !r.friendly).slice(0, limit * 4);
  const replays: PvpReplay[] = [];
  for (const s of recent) {
    let d = details.get(s.file);
    if (!d) {
      d = archive.detail(s.file) ?? undefined;
      if (d) details.set(s.file, d);
    }
    if (d?.log?.length) replays.push(d);
  }
  const stats = state.combat.stats;
  const perks = (save?.equippedPerkIds ?? []).filter((id) => id > 0);
  const all = buildArena(
    replays,
    {
      byName: BY_NAME,
      split: save ? { atk: save.allocatedAtk, def: save.allocatedDef, crit: save.allocatedCrit, parry: save.allocatedParry } : {},
      ...(stats ? { today: { stats, perkIds: perks } } : {}),
      scouts: state.scouts,
    },
    limit * 4,
  ).map((a) => a.opponent);
  const seen = new Set<string>();
  const distinct = all.filter((o) => (seen.has(o.name) ? false : (seen.add(o.name), true)));
  const exact = distinct.filter((o) => o.statsSource === 'jogo' && o.perkSource === 'jogo');
  return exact.length >= limit ? exact.slice(0, limit) : [...exact, ...distinct.filter((o) => !exact.includes(o))].slice(0, limit);
}

