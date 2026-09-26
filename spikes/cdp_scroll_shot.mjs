// Dev check: screenshot one page after scrolling. Usage: node spikes/cdp_scroll_shot.mjs <port> <out.png> <menu label> <scrollY>
import { writeFileSync } from 'node:fs';
const [port, out, label, y] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    const onMsg = (e) => { const m = JSON.parse(e.data); if (m.id !== id) return; ws.removeEventListener('message', onMsg); resolve(m.result); };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
await call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 900, deviceScaleFactor: 1, mobile: false });
await call('Runtime.evaluate', {
  expression: `(() => { const b = [...document.querySelectorAll('button,a')].find(e => e.textContent.trim().includes(${JSON.stringify(label)})); if (b) b.click(); })()`,
});
await new Promise((r) => setTimeout(r, 900));
await call('Runtime.evaluate', { expression: `document.querySelector('main, #root > div > div:last-child')?.scrollTo(0, ${y}) ?? window.scrollTo(0, ${y})` });
await new Promise((r) => setTimeout(r, 400));
const { data } = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved', out);
ws.close();
