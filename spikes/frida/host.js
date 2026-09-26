// Frida host spike: attach to Lootborne.exe, load the read-only agent, log events, then detach.
// Usage: node host.js [seconds]
const fs = require('fs');
const path = require('path');
const frida = require('frida');

const seconds = Number(process.argv[2] || 60);
const outFile = path.join(__dirname, '..', 'out', process.env.LBP_OUT || 'frida_events.jsonl');

async function main() {
  const device = await frida.getLocalDevice();
  const target = (await device.enumerateProcesses()).find((p) => /^lootborne\.exe$/i.test(p.name));
  if (!target) throw new Error('Lootborne.exe not running');
  const t0 = Date.now();
  const session = await device.attach(target.pid);
  session.detached.connect((reason) => log({ ev: 'session_detached', reason }));
  const script = await session.createScript(fs.readFileSync(path.join(__dirname, process.env.LBP_AGENT || 'agent.js'), 'utf8'));
  script.message.connect((msg) => {
    if (msg.type === 'send') log(msg.payload);
    else log({ ev: 'agent_error', description: msg.description, stack: msg.stack });
  });
  await script.load();
  log({ ev: 'attached', pid: target.pid, attach_ms: Date.now() - t0, seconds });

  let done = false;
  const stop = async () => {
    if (done) return;
    done = true;
    try { await script.exports.dispose(); } catch (e) { log({ ev: 'dispose_error', error: String(e) }); }
    await script.unload();
    await session.detach();
    log({ ev: 'detached' });
  };
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
  setTimeout(() => stop().then(() => process.exit(0)), seconds * 1000);
}

function log(payload) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...payload });
  console.log(line);
  fs.appendFileSync(outFile, line + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
