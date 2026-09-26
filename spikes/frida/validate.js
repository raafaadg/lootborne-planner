// Loads the app's read-only agent for N seconds and records everything to out/combat_validation.jsonl,
// to check the damage formula against real turns. Usage: node spikes/frida/validate.js [seconds]
const fs = require('fs');
const path = require('path');
const frida = require('frida');

const seconds = Number(process.argv[2] || 100);
const out = path.join(__dirname, '..', 'out', 'combat_validation.jsonl');
fs.writeFileSync(out, '');

(async () => {
  const device = await frida.getLocalDevice();
  const target = (await device.enumerateProcesses()).find((p) => /^lootborne\.exe$/i.test(p.name));
  const session = await device.attach(target.pid);
  const script = await session.createScript(fs.readFileSync(path.join(__dirname, '../../src/main/live/agent.js'), 'utf8'));
  script.message.connect((m) => {
    const payload = m.type === 'send' ? m.payload : { ev: 'error', description: m.description };
    if (payload.ev === 'hb' || payload.ev === 'player') return;
    fs.appendFileSync(out, JSON.stringify({ t: Date.now(), ...payload }) + '\n');
    if (payload.ev !== 'turn') console.log(JSON.stringify(payload).slice(0, 400));
  });
  await script.load();
  setTimeout(async () => {
    await script.exports.dispose();
    await script.unload();
    await session.detach();
    console.log('done');
    process.exit(0);
  }, seconds * 1000);
})();
