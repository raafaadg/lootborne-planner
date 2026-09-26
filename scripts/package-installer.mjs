// Windows installer (NSIS) from the portable folder `npm run dist` just assembled, so the installer and
// the zip carry exactly the same files. Usage: npm run dist && npm run dist:installer
// Output: release/installer/Lootborne-Planner-Setup-<version>.exe
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const portable = join(root, 'release', `Lootborne-Planner-v${pkg.version}-win-x64`);
if (!existsSync(join(portable, 'Lootborne Planner.exe'))) throw new Error(`run \`npm run dist\` first (no ${portable})`);

const cli = join(root, 'node_modules', 'electron-builder', 'cli.js');
execFileSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--prepackaged', portable, '--config', 'electron-builder.yml', '--publish', 'never'], {
  cwd: root,
  stdio: 'inherit',
});
const out = join(root, 'release', 'installer', `Lootborne-Planner-Setup-${pkg.version}.exe`);
if (!existsSync(out)) throw new Error(`the installer was not written: ${out}`);
console.log(out);
