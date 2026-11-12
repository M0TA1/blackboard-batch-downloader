import { readFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extension = join(root, 'extension');
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.host_permissions?.length) throw new Error('Unexpected manifest permissions.');
for (const file of [manifest.background.service_worker, manifest.action.default_popup, 'popup.js', 'popup.css', 'file-types.js', 'scanner.js', 'selection.js', 'queue.js']) {
  if (file.includes('..') || resolve(extension, file) !== join(extension, file)) throw new Error('Invalid package path.');
  await access(join(extension, file));
}
const output = join(root, 'dist', `blackboard-batch-downloader-v${manifest.version}.zip`);
await mkdir(join(root, 'dist'), { recursive: true });
execFileSync('zip', ['-q', '-r', '-FS', output, '.', '-x', '*.DS_Store'], { cwd: extension });
execFileSync('unzip', ['-t', output], { stdio: 'pipe' });
const hash = createHash('sha256').update(await readFile(output)).digest('hex');
console.log(`${output}\nSHA256 ${hash}`);
