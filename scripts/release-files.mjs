import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

// Adding a source file to an export requires an explicit review of this list.
export function releaseFiles(root = '.') {
  const files = JSON.parse(readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
  if (!Array.isArray(files) || new Set(files).size !== files.length) throw new Error('Invalid release manifest');
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.includes('\\') || path.isAbsolute(file)) throw new Error('Invalid release path');
    const parts = file.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid release path');
    const allowedDotfiles = ['.env.example', '.gitignore', '.dockerignore'];
    if (parts.some((part, i) => part.startsWith('.') && !(i === 0 && (allowedDotfiles.includes(file) || part === '.github')))) throw new Error(`Private release path: ${file}`);
    if (parts.some(part => ['config.json', 'config.local.json', 'node_modules'].includes(part))) throw new Error(`Private release path: ${file}`);
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(path.join(root, ...parts.slice(0, i)));
      if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe release path: ${file}`);
    }
  }
  return files.sort();
}
