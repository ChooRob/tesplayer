// TRUST_PROXY for Express, with container and host names allowed.
//
// Express only takes IP addresses, subnets and a few presets (loopback,
// linklocal, uniquelocal). In Docker the proxy is usually known by its container
// name, so a name here is looked up and replaced by its address(es). Names are
// looked up again every few minutes, because a container that restarts can come
// back with a new address; anything else in the list is passed through unchanged.

import { promises as dns } from 'node:dns';
import net from 'node:net';

export const RESOLVE_EVERY_MS = 10 * 60 * 1000;

const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const NAME = /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/;

export const trustEntries = value => String(value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);

// A name to look up: not a preset, an address, a subnet or a plain number.
export const isHostName = entry => !PRESETS.has(entry) && !/^\d+$/.test(entry) && !net.isIP(entry.split('/')[0]) && NAME.test(entry);

// The list Express should use: names replaced by `address/32` (or `/128`).
// Throws when a name does not resolve, without repeating it.
export async function resolveTrustProxy(value, { lookup = dns.lookup } = {}) {
  const resolved = [];
  for (const entry of trustEntries(value)) {
    if (!isHostName(entry)) { resolved.push(entry); continue; }
    let found;
    try { found = await lookup(entry, { all: true }); } catch { found = []; }
    if (!found.length) throw new Error('TRUST_PROXY names a host that could not be found.');
    for (const { address, family } of found) resolved.push(`${address}/${family === 6 ? 128 : 32}`);
  }
  return resolved;
}

// Sets `trust proxy` on the app and keeps names current. The first lookup must
// succeed (the server does not start otherwise); a later failure keeps the last
// good addresses and is logged. Returns a function that stops the refreshing.
export async function applyTrustProxy(app, value, { lookup, intervalMs = RESOLVE_EVERY_MS, warn = console.warn } = {}) {
  let current = await resolveTrustProxy(value, { lookup });
  app.set('trust proxy', current);
  if (!trustEntries(value).some(isHostName)) return () => {};
  const timer = setInterval(async () => {
    try {
      const next = await resolveTrustProxy(value, { lookup });
      if (next.join() !== current.join()) { current = next; app.set('trust proxy', next); }
    } catch { warn('Setup: TRUST_PROXY could not be looked up again; keeping the previous addresses.'); }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
