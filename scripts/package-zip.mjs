// Portable Windows build: the Electron runtime already in node_modules + our build + the runtime part
// of frida, zipped. No downloads. Usage: npm run dist
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `Lootborne-Planner-v${pkg.version}-win-x64`;
const releaseDir = join(root, 'release');
const outDir = join(releaseDir, name);
const appDir = join(outDir, 'resources', 'app');
const nm = join(root, 'node_modules');
const KEEP_LOCALES = new Set(['en-US.pak', 'pt-BR.pak']);

if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('run `electron-vite build` first');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// 1. Electron runtime, renamed; only the locales we use; no default app
cpSync(join(nm, 'electron', 'dist'), outDir, { recursive: true });
renameSync(join(outDir, 'electron.exe'), join(outDir, 'Lootborne Planner.exe'));
for (const f of readdirSync(join(outDir, 'locales'))) if (!KEEP_LOCALES.has(f)) rmSync(join(outDir, 'locales', f));
rmSync(join(outDir, 'resources', 'default_app.asar'), { force: true });

// 2. The app: build output + a minimal package.json
mkdirSync(appDir, { recursive: true });
cpSync(join(root, 'out'), join(appDir, 'out'), { recursive: true });
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, private: true }, null, 2),
);

// 3. frida: only what loads at runtime (build/src + the native binding), then its runtime deps
const fridaSrc = join(nm, 'frida');
const fridaDst = join(appDir, 'node_modules', 'frida');
for (const rel of ['package.json', 'README.md', join('build', 'src'), join('build', 'frida_binding.node')]) {
  cpSync(join(fridaSrc, rel), join(fridaDst, rel), { recursive: true });
}
const RUNTIME_ONLY = { frida: ['bindings', 'minimatch'] }; // prebuild-install is install-time only
const queue = [...RUNTIME_ONLY.frida];
const copied = new Set();
while (queue.length) {
  const dep = queue.shift();
  if (copied.has(dep)) continue;
  copied.add(dep);
  cpSync(join(nm, dep), join(appDir, 'node_modules', dep), { recursive: true });
  const deps = JSON.parse(readFileSync(join(nm, dep, 'package.json'), 'utf8')).dependencies ?? {};
  queue.push(...Object.keys(deps));
}

// 4. Docs and licences
cpSync(join(root, 'NOTICE'), join(outDir, 'NOTICE.txt'));
cpSync(join(root, 'scripts', 'LEIA-ME.txt'), join(outDir, 'LEIA-ME.txt'));

// 5. Zip with Windows' bsdtar (-a picks the format from the .zip extension)
const zipPath = join(releaseDir, `${name}.zip`);
rmSync(zipPath, { force: true });
execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', zipPath, '-C', releaseDir, name], { stdio: 'inherit' });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`runtime deps: frida + ${[...copied].join(', ')}`);
console.log(`${zipPath} (${mb(zipPath)} MB)`);
