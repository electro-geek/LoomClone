// Builds a Chrome Web Store upload zip.
//
//   node tools/package.mjs
//
// The store wants a zip whose ROOT is manifest.json — not a folder containing it.
// Zipping the extension/ directory itself is the single most common upload
// rejection, so this zips its contents from inside.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension');
const OUT_DIR = join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
const slug = manifest.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');
const outFile = join(OUT_DIR, `${slug}-v${manifest.version}.zip`);

/* ------------------------------------------------------------------- checks */

const problems = [];

if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  problems.push(`version "${manifest.version}" must be 1–4 dot-separated integers`);
}
if (manifest.description.length > 132) {
  problems.push(`description is ${manifest.description.length} chars (store max is 132)`);
}
for (const size of ['16', '48', '128']) {
  const icon = manifest.icons?.[size];
  if (!icon || !existsSync(join(SRC, icon))) {
    problems.push(`missing icon ${size} (run: node tools/make-icons.mjs)`);
  }
}
if (!manifest.name || manifest.name.length > 75) {
  problems.push('name must be present and at most 75 characters');
}

if (problems.length) {
  console.error('✗ cannot package:');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}

/* -------------------------------------------------------------------- build */

mkdirSync(OUT_DIR, { recursive: true });
rmSync(outFile, { force: true });

// -r recurse, -q quiet, -X drop platform extras. Excludes keep junk out of review.
execFileSync(
  'zip',
  ['-r', '-q', '-X', outFile, '.', '-x', '.*', '-x', '__MACOSX/*', '-x', '*/.DS_Store'],
  { cwd: SRC, stdio: 'inherit' },
);

const kb = Math.round(statSync(outFile).size / 1024);
const listed = execFileSync('zip', ['-sf', outFile], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('Archive') && !l.includes('total'))
  .map((l) => l.trim());

console.log(`✓ ${outFile}  (${kb} KB, ${listed.length} files)`);
if (!listed.includes('manifest.json')) {
  console.error('✗ manifest.json is not at the zip root — the store will reject this');
  process.exit(1);
}
console.log('\nmanifest.json is at the zip root, which is what the store requires.');
console.log('Upload it at https://chrome.google.com/webstore/devconsole');
