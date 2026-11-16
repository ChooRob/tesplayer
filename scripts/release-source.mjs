import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseFiles } from './release-files.mjs';

execFileSync(process.execPath, ['scripts/check-release.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/verify-vendor.mjs'], { stdio: 'inherit' });
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-export-'));
try {
  const root = path.join(temporary, 'tesladash');
  for (const file of releaseFiles()) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(file, path.join(root, file), { dereference: false });
  }
  // Never export a deployment's profile mappings or altered authentication config.
  copyFileSync('config.example.json', path.join(root, 'config.json'));
  mkdirSync('release', { recursive: true });
  const archive = path.resolve('release/tesladash-source.tar.gz');
  const ownership = process.platform === 'darwin'
    ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
    : ['--owner=0', '--group=0', '--numeric-owner'];
  execFileSync('tar', [...ownership, '-czf', archive, '-C', temporary, 'tesladash'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  console.log(`Created ${archive}; no Git history, credentials or runtime state included.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
