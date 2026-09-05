import { readdir, readFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isUpdatePath } from '../lib/folder-update.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw new Error('Invalid manifest version');
const paths = [];
async function collect(directory = '') {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory() && ['lib', 'fonts', 'icons'].includes(path)) await collect(path);
    else if (entry.isDirectory() && directory && isUpdatePath(`${path}/file`)) await collect(path);
    else if (entry.isFile() && isUpdatePath(path)) paths.push(path);
    else if (entry.isSymbolicLink() && isUpdatePath(path)) throw new Error(`Symlink cannot be packaged: ${path}`);
  }
}
await collect();
const outputDir = resolve(root, 'dist');
await mkdir(outputDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'gw-worktime-package-'));
// Keep the unpacked folder name stable when a file manager expands the ZIP.
const output = join(outputDir, 'amaranth-worktime-extension.zip');
try {
  const archive = join(temporary, 'extension.zip');
  const result = spawnSync('zip', ['-q', '-X', archive, '-@'], {
    cwd: root, input: paths.sort().join('\n') + '\n', encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'ZIP packaging failed');
  await rename(archive, output);
  console.log(`${output} (${paths.length} runtime files)`);
} finally { await rm(temporary, { recursive: true, force: true }); }
