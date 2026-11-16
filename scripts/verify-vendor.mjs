import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const metadata = JSON.parse(readFileSync(new URL('../vendor.json', import.meta.url)));
const sha = data => createHash('sha256').update(data).digest('hex');
const bundle = readFileSync(new URL('../' + metadata.file, import.meta.url));
if (sha(bundle) !== metadata.sha256) throw new Error('Vendored bundle checksum mismatch');
if (!bundle.includes(`var VERSION = "${metadata.version}"`) || !bundle.includes('Mozilla Public')) throw new Error('Missing version or license header');
if (process.argv.includes('--upstream')) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-vendor-'));
  try {
    const result = JSON.parse(execFileSync('npm', ['pack', `${metadata.name}@${metadata.version}`, '--ignore-scripts', '--pack-destination', temporary, '--json'], { encoding: 'utf8' }));
    const tarball = path.join(temporary, path.basename(result[0].filename));
    const upstream = execFileSync('tar', ['-xOf', tarball, 'package/dist/bundles/mediabunny.mjs'], { maxBuffer: 10 * 1024 * 1024 });
    if (sha(upstream) !== metadata.sha256) throw new Error('Upstream bundle differs: review provenance before releasing');
    console.log(`Upstream ${metadata.name}@${metadata.version} matches; npm integrity: ${result[0].integrity}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
console.log(`Verified ${metadata.name}@${metadata.version}: ${metadata.sha256}`);
