import { inventoryCapForLevel } from '@shared/game-math';
import { Notification } from 'electron';
import type { GameEvent, NotifySettings } from '@shared/contracts';
import { rarityIndex } from '@shared/game-math';
import type { AppState } from './app-state';

const DEATH_WINDOW_MS = 15 * 60_000;

export interface Notice {
  title: string;
  body: string;
}

/** Turns game events and periodic checks into Windows toasts (+ optional Discord webhook). */
export class Notifier {
  #deaths: number[] = [];
  #stalledNotified = false;
  #capNotified = false;

  constructor(private readonly state: AppState) {
    state.on('event', (e) => this.#onEvent(e));
  }

  get settings(): NotifySettings {
    return this.state.settings.notify;
  }

  #onEvent(e: GameEvent): void {
    const s = this.settings;
    switch (e.kind) {
      case 'drop':
        if (rarityIndex(e.item.rarity) >= rarityIndex(s.dropMinRarity)) {
          this.send({ title: `Drop ${e.item.rarity}!`, body: `${e.item.name} (${e.item.grantSource ?? 'drop'})` });
        }
        break;
      case 'level_up':
        if (s.levelUp) this.send({ title: `Nível ${e.to}!`, body: e.unspent > 0 ? `${e.unspent} pontos de atributo para distribuir` : 'Subiu de nível' });
        break;
      case 'death': {
        const now = Date.now();
        this.#deaths = [...this.#deaths.filter((t) => now - t < DEATH_WINDOW_MS), now];
        if (s.deathStreak > 0 && this.#deaths.length % s.deathStreak === 0) {
          this.send({ title: 'Mortes seguidas no setor', body: `${this.#deaths.length} mortes em 15 min; vale revisar equipamento e atributos` });
        }
        break;
      }
      case 'sector_change':
        this.#deaths = [];
        if (e.cleared) this.send({ title: 'Setor concluído', body: `Avançou para o setor ${e.to}` });
        break;
      case 'autofight':
        if (!e.on && e.reason === 'stamina') this.send({ title: 'Autofight parou', body: 'Stamina esgotada; ele volta quando recarregar' });
        break;
      case 'battle':
        this.#stalledNotified = false;
        break;
      default:
        break;
    }
  }

  /** Called every few seconds. */
  check(): void {
    const s = this.settings;
    const save = this.state.save?.state;
    if (!save) return;
    const quietFor = (Date.now() - this.state.lastSaveAt) / 1000;
    if (this.state.gameRunning && s.battleStalledSeconds > 0 && quietFor > s.battleStalledSeconds && !this.#stalledNotified) {
      this.#stalledNotified = true;
      this.send({ title: 'Nenhuma batalha', body: `Sem lutas há ${Math.round(quietFor / 60)} min (${save.battleActive ? 'jogo parado?' : 'batalha pausada'})` });
    }
    const cap = inventoryCapForLevel(save.level);
    const nearCap = save.inventory.length >= cap * 0.9;
    if (s.inventoryNearCap && nearCap && !this.#capNotified) {
      this.#capNotified = true;
      this.send({ title: 'Inventário quase cheio', body: `${save.inventory.length}/${cap} itens` });
    }
    if (!nearCap) this.#capNotified = false;
  }

  send(notice: Notice, force = false): void {
    const s = this.settings;
    if (!s.enabled && !force) return;
    if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.body, silent: false }).show();
    if (s.discordWebhook.startsWith('https://')) {
      void fetch(s.discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${notice.title}**: ${notice.body}` }),
      }).catch(() => undefined);
    }
  }
}
