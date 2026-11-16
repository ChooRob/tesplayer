import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const dataDir = process.env.DATA_DIR || path.dirname(fileURLToPath(import.meta.url));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export function readPrivateJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  chmodSync(file, 0o600);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writePrivateJson(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

export function installationId() {
  const file = path.join(dataDir, '.installation.json');
  const stored = readPrivateJson(file, null);
  if (stored?.id) return stored.id;
  const id = crypto.randomUUID();
  writePrivateJson(file, { id });
  return id;
}
