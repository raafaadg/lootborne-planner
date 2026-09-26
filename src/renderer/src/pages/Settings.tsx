import { useEffect, useState } from 'react';
import { RARITIES, type AppSnapshot, type DeepPartial, type LiveStatus, type Settings } from '@shared/contracts';
import { Button, FilterChip, Panel, Pill, Toggle, ago } from '../ui';

const ZOOMS = [1, 1.1, 1.15, 1.25, 1.4];

const STATUS_LABEL: Record<LiveStatus, string> = {
  off: 'desligado',
  waiting: 'aguardando o jogo',
  attaching: 'conectando',
  live: 'ao vivo',
  error: 'erro',
  unavailable: 'indisponível',
};

export function SettingsPage({ snapshot }: { snapshot: AppSnapshot }) {
  const { settings, live } = snapshot;
  const [webhook, setWebhook] = useState(settings.notify.discordWebhook);
  useEffect(() => setWebhook(settings.notify.discordWebhook), [settings.notify.discordWebhook]);
  const update = (patch: DeepPartial<Settings>) => void window.planner.updateSettings(patch);
  const n = settings.notify;

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Panel title="Aparência" className="xl:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px]">Tamanho da letra</span>
          {ZOOMS.map((z) => (
            <FilterChip key={z} on={Math.abs(settings.ui.zoom - z) < 0.001} onClick={() => update({ ui: { zoom: z } })}>
              {Math.round(z * 100)}%
            </FilterChip>
          ))}
          <span className="text-[11px] text-muted">aumenta textos, botões e tabelas juntos</span>
        </div>
      </Panel>
      <Panel title="Modo ao vivo (Frida)" actions={<Pill state={live.status === 'live' ? 'on' : live.status === 'error' || live.status === 'unavailable' ? 'ruim' : live.status === 'off' ? 'off' : 'alerta'} pulse={live.status === 'live'}>{STATUS_LABEL[live.status]}</Pill>}>
        <p className="m-0 text-[13px] leading-relaxed text-muted">
          Com o modo ao vivo, o Planner se conecta ao processo do Lootborne com o Frida e <b className="text-ink">só observa</b> o que o jogo já faz: início e fim de cada luta, cada turno,
          drops no instante, troca de tela, autofight, PWR e XP necessário por nível. Ele não altera memória, não chama funções do jogo e desconecta quando você desliga ou fecha o app.
        </p>
        <p className="m-0 text-[11px] leading-relaxed text-muted">
          Ele injeta um agente no processo do jogo. Nos testes, o anti-cheat do jogo não detecta isso e o jogo seguiu estável, mas é mais invasivo que ler o save. Se algo der errado, o app
          continua funcionando só com o save.
        </p>
        <Toggle
          checked={settings.live.enabled}
          onChange={(v) => update({ live: { enabled: v } })}
          label="Ativar modo ao vivo"
          hint={settings.live.consentAt ? `autorizado em ${new Date(settings.live.consentAt).toLocaleString('pt-BR')}` : 'desligado por padrão'}
        />
        <dl className="m-0 grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Status</dt>
          <dd className="m-0">{STATUS_LABEL[live.status]}{live.detail ? ` · ${live.detail}` : ''}</dd>
          {live.pid && (
            <>
              <dt className="text-muted">Processo</dt>
              <dd className="m-0 num">pid {live.pid}</dd>
            </>
          )}
          {live.since && (
            <>
              <dt className="text-muted">Conectado há</dt>
              <dd className="m-0">{ago(live.since)}</dd>
            </>
          )}
          {live.lastMessageAt && (
            <>
              <dt className="text-muted">Última mensagem</dt>
              <dd className="m-0">há {ago(live.lastMessageAt)}</dd>
            </>
          )}
          {live.hooks && (
            <>
              <dt className="text-muted">Hooks</dt>
              <dd className="m-0">
                {live.hooks.ok.length} ok{live.hooks.failed.length ? `, ${live.hooks.failed.length} falharam: ${live.hooks.failed.join('; ')}` : ''}
              </dd>
            </>
          )}
        </dl>
      </Panel>

      <Panel title="Alertas" actions={<Button mini onClick={() => void window.planner.testNotification()}>testar</Button>}>
        <Toggle checked={n.enabled} onChange={(v) => update({ notify: { enabled: v } })} label="Notificações do Windows" />
        <div className="flex flex-col gap-1.5 border-b border-row py-1.5">
          <span className="text-[13px]">Avisar drops a partir de</span>
          <div className="flex flex-wrap gap-1.5">
            {RARITIES.map((r) => (
              <FilterChip key={r} on={n.dropMinRarity === r} onClick={() => update({ notify: { dropMinRarity: r } })}>
                <span style={{ color: `var(--color-rar-${RARITIES.indexOf(r)})` }}>{r}</span>
              </FilterChip>
            ))}
          </div>
        </div>
        <Toggle checked={n.levelUp} onChange={(v) => update({ notify: { levelUp: v } })} label="Subiu de nível / pontos para distribuir" />
        <Toggle
          checked={n.inventoryNearCap}
          onChange={(v) => update({ notify: { inventoryNearCap: v } })}
          label="Inventário com 90% ou mais"
          hint="a bolsa tem 150 espaços, 200 a partir do nível 30 e 300 a partir do 60, como no jogo"
        />
        <NumberRow label="Mortes seguidas para avisar" hint="dentro de 15 min no mesmo setor; 0 desliga" value={n.deathStreak} onChange={(v) => update({ notify: { deathStreak: v } })} />
        <NumberRow label="Avisar se não houver luta por (s)" hint="com o jogo aberto; 0 desliga" value={n.battleStalledSeconds} onChange={(v) => update({ notify: { battleStalledSeconds: v } })} />
        <label className="flex flex-col gap-1 py-1.5">
          <span className="text-[13px]">Webhook do Discord (opcional)</span>
          <input
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            onBlur={() => update({ notify: { discordWebhook: webhook.trim() } })}
            placeholder="https://discord.com/api/webhooks/…"
            className="rounded-lg border border-line bg-bg-2 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
        </label>
        <Button className="self-start" onClick={() => void window.planner.openDataFolder()}>
          📂 Abrir pasta de dados do jogo
        </Button>
      </Panel>
    </div>
  );
}

function NumberRow({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="flex items-center justify-between gap-4 border-b border-row py-1.5">
      <span className="flex flex-col">
        <span className="text-[13px]">{label}</span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </span>
      <input
        type="number"
        min={0}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = Math.max(0, Math.round(Number(draft) || 0));
          if (v !== value) onChange(v);
        }}
        className="num w-24 rounded-lg border border-line bg-bg-2 px-2 py-1 text-right text-[13px] text-ink outline-none focus:border-accent"
      />
    </label>
  );
}
