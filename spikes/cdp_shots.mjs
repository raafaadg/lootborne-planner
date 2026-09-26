// Dev check: screenshot every Planner page over the DevTools protocol (app started with LBP_DEBUG_PORT).
// Usage: node spikes/cdp_shots.mjs [port] [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2] ?? '9223';
const outDir = process.argv[3] ?? 'spikes/out/shots';
const PAGES = (process.argv[4] ?? 'Visão geral,Simulador,Inventário,Build,Timeline,PvP,Alertas & Ao vivo').split(',');

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    const onMsg = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

mkdirSync(outDir, { recursive: true });
await call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 900, deviceScaleFactor: 1, mobile: false });
for (const [i, label] of PAGES.entries()) {
  await call('Runtime.evaluate', { expression: `document.querySelector('nav button[title="${label}"]')?.click()` });
  await new Promise((r) => setTimeout(r, label === 'Simulador' || label === 'Build' ? 5000 : 600));
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${i}-${label.replace(/[^\w]+/g, '_')}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('saved', file);
}
await call('Runtime.evaluate', { expression: `document.querySelector('nav button[title="Visão geral"]')?.click()` });
await call('Emulation.clearDeviceMetricsOverride');
ws.close();
