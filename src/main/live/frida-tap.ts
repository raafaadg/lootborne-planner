import { EventEmitter } from 'node:events';
import type { LiveStatus } from '@shared/contracts';
import agentSource from './agent.js?raw';

/** Anything the agent `send()`s; `ev` discriminates. */
export interface AgentMessage {
  ev: string;
  [key: string]: unknown;
}

type Frida = typeof import('frida');
type Session = Awaited<ReturnType<Frida['attach']>>;
type Script = Awaited<ReturnType<Session['createScript']>>;

const POLL_MS = 5_000;
const SILENCE_MS = 20_000; // the agent beats every 5 s
const DETACH_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 8_000;
const ERROR_BACKOFF_MS = 60_000;

/**
 * Optional live source: attaches Frida to Lootborne.exe and loads the read-only agent. Disabled
 * until the user opts in; any failure falls back to "waiting" and the save file keeps the app fed.
 */
export class FridaTap extends EventEmitter<{
  status: [LiveStatus, { detail?: string; pid?: number }];
  message: [AgentMessage];
}> {
  #frida: Frida | null = null;
  #session: Session | null = null;
  #script: Script | null = null;
  #pid: number | null = null;
  #enabled = false;
  #busy = false;
  #timer: NodeJS.Timeout | null = null;
  #lastMessage = 0;
  #retryAt = 0;

  async enable(): Promise<void> {
    if (this.#enabled) return;
    this.#enabled = true;
    try {
      this.#frida ??= await import('frida');
    } catch (error) {
      this.#enabled = false;
      this.emit('status', 'unavailable', { detail: `frida não carregou: ${String(error)}` });
      return;
    }
    this.emit('status', 'waiting', {});
    this.#timer = setInterval(() => void this.#tick(), POLL_MS);
    void this.#tick();
  }

  async disable(): Promise<void> {
    this.#enabled = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#teardown();
    this.emit('status', 'off', {});
  }

  async #tick(): Promise<void> {
    if (!this.#enabled || this.#busy || !this.#frida) return;
    this.#busy = true;
    try {
      if (this.#session) {
        if (Date.now() - this.#lastMessage > SILENCE_MS) {
          await this.#teardown();
          this.emit('status', 'waiting', { detail: 'agente em silêncio; reconectando' });
        }
        return;
      }
      if (Date.now() < this.#retryAt) return;
      const device = await this.#frida.getLocalDevice();
      const target = (await device.enumerateProcesses()).find((p) => /^lootborne\.exe$/i.test(p.name));
      if (!target) {
        this.emit('status', 'waiting', { detail: 'Lootborne.exe não está rodando' });
        return;
      }
      await this.#attach(device, target.pid);
    } catch (error) {
      await this.#teardown();
      this.#retryAt = Date.now() + ERROR_BACKOFF_MS;
      this.emit('status', 'error', { detail: `${String(error)} (nova tentativa em 1 min)` });
    } finally {
      this.#busy = false;
    }
  }

  async #attach(device: Awaited<ReturnType<Frida['getLocalDevice']>>, pid: number): Promise<void> {
    this.emit('status', 'attaching', { pid });
    const session = await device.attach(pid);
    this.#session = session;
    this.#pid = pid;
    session.detached.connect((reason) => {
      if (this.#session !== session) return;
      this.#session = null;
      this.#script = null;
      if (this.#enabled) this.emit('status', 'waiting', { detail: `sessão encerrada (${String(reason)})` });
    });
    const script = await session.createScript(agentSource);
    this.#script = script;
    script.message.connect((message) => {
      this.#lastMessage = Date.now();
      if (message.type === 'send') this.emit('message', message.payload as AgentMessage);
      else this.emit('message', { ev: 'agent_error', description: message.description, stack: message.stack });
    });
    this.#lastMessage = Date.now();
    // Top-level errors in the agent don't reject load(); only its `ready` message proves it runs.
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('o agente não respondeu')), READY_TIMEOUT_MS);
      const onMessage = (msg: AgentMessage) => {
        if (msg.ev !== 'ready' && msg.ev !== 'agent_error') return;
        clearTimeout(timeout);
        this.off('message', onMessage);
        if (msg.ev === 'ready') resolve();
        else reject(new Error(`erro no agente: ${String(msg.description)}`));
      };
      this.on('message', onMessage);
    });
    await script.load();
    await ready;
    this.emit('status', 'live', { pid });
  }

  async #teardown(): Promise<void> {
    const script = this.#script;
    const session = this.#session;
    this.#script = null;
    this.#session = null;
    this.#pid = null;
    const work = (async () => {
      try {
        await script?.exports.dispose?.();
      } catch {
        // process already gone
      }
      try {
        await script?.unload();
      } catch {
        // ignore
      }
      try {
        await session?.detach();
      } catch {
        // ignore
      }
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, DETACH_TIMEOUT_MS))]);
  }

  get pid(): number | null {
    return this.#pid;
  }
}
