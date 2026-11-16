// Load structured settings from config.json; keep credentials in the environment.
// config.example.json contains distributable defaults.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json');

const DEFAULTS = {
  auth: {
    enabled: true,
    requireServerAccess: true,
    sessionDays: 30,
    maxSessions: 1000,
    secureCookies: process.env.NODE_ENV === 'production',
  },
  plex: {
    productName: 'FreeStuffCrazy Player',
    videoBitrate: 4000,
    maxSessions: 8,
    sessionIdleMinutes: 30,
    profileAccountIds: {},
  },
};

function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn(`No config.json found at ${CONFIG_PATH} -- copy config.example.json and fill it in. Using defaults for now.`);
  }
  return {
    auth: { ...DEFAULTS.auth, ...fileConfig.auth },
    plex: { ...DEFAULTS.plex, ...fileConfig.plex },
  };
}

export const config = loadConfig();
for (const key of ['enabled', 'requireServerAccess', 'secureCookies']) {
  if (typeof config.auth[key] !== 'boolean') throw new Error(`Invalid auth.${key}`);
}
for (const [name, value, max] of [
  ['auth.sessionDays', config.auth.sessionDays, 90],
  ['auth.maxSessions', config.auth.maxSessions, 10000],
  ['plex.maxSessions', config.plex.maxSessions, 100],
  ['plex.sessionIdleMinutes', config.plex.sessionIdleMinutes, 240],
  ['plex.videoBitrate', config.plex.videoBitrate, 100000],
]) {
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`);
}
if (process.env.NODE_ENV === 'production' && !config.auth.secureCookies) {
  throw new Error('Production requires Secure cookies and HTTPS');
}

if (!config.plex.profileAccountIds || typeof config.plex.profileAccountIds !== 'object'
  || Array.isArray(config.plex.profileAccountIds)
  || Object.entries(config.plex.profileAccountIds).some(([key, value]) => !/^\d+$/.test(key) || !/^\d+$/.test(String(value)))) {
  throw new Error('Invalid plex.profileAccountIds');
}
