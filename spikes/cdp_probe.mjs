// Dev check: read the Planner renderer over the DevTools protocol (app started with LBP_DEBUG_PORT).
// Usage: node spikes/cdp_probe.mjs [port] [js-expression]
const port = process.argv[2] ?? '9223';
const expr =
  process.argv[3] ??
  `window.planner.getSnapshot().then((s) => JSON.stringify({
     live: { ...s.live, hooks: s.live.hooks && s.live.hooks.ok.length },
     lastEvents: s.events.slice(-4).map((e) => [e.t.slice(11, 19), e.kind, e.enemy ?? e.item?.name ?? '']),
     xpTable: s.xpTable, stats: s.stats,
     rendered: document.querySelector('main')?.innerText.slice(0, 700),
   }, null, 1))`;

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((p) => p.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
const msg = await new Promise((r) => ws.addEventListener('message', (e) => r(JSON.parse(e.data)), { once: true }));
console.log(msg.result?.result?.value ?? JSON.stringify(msg, null, 1));
ws.close();
