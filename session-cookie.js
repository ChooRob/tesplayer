// Encrypt and authenticate small JSON payloads for HttpOnly cookies, so the
// browser can carry sign-in state (including Plex tokens) without the server
// storing it. AES-256-GCM: tampered, expired or wrong-purpose values open as null.

import crypto from 'node:crypto';

const VERSION = 'v1';

export function createCookieSealer(secret, { now = Date.now } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Cookie secret must contain at least 32 characters');
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'FreeStuffCrazy Player cookie encryption v1', 32));

  // purpose is bound as associated data, so a login cookie can never be
  // replayed as a session cookie (or the reverse).
  function seal(purpose, payload, maxAgeMs) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.from(JSON.stringify({ ...payload, exp: now() + maxAgeMs }));
    const sealed = Buffer.concat([iv, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${sealed.toString('base64url')}`;
  }

  function open(purpose, value) {
    if (typeof value !== 'string' || !value.startsWith(`${VERSION}.`)) return null;
    try {
      const sealed = Buffer.from(value.slice(VERSION.length + 1), 'base64url');
      if (sealed.length < 29) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const body = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
      const payload = JSON.parse(body.toString('utf8'));
      if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.exp) || payload.exp <= now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  return { seal, open };
}

export const SESSION_COOKIE_NAME = 'freeStuffCrazyPlayerSession';

// The session cookie holds the signed-in credential for each media source
// (Plex, and later others) plus which one is active:
//   { v: 4, sid, active: '<source id>', creds: { '<source id>': { type, ... } }, renewedAt }
// Only one source is signed in at a time for now; switching later just adds
// another entry. Earlier (v3) cookies were Plex-only and flat; they open as
// that source's credential so nobody is signed out by the change.
export function packSession({ sid, sourceId, credential, renewedAt }) {
  return { v: 4, sid, active: sourceId, creds: { [sourceId]: credential }, renewedAt };
}

export function unpackSession(payload, { legacySourceId, legacyType }) {
  if (!payload || typeof payload !== 'object' || typeof payload.sid !== 'string') return null;
  if (payload.v === 4) {
    const { active, creds } = payload;
    if (typeof active !== 'string' || !creds || typeof creds !== 'object' || !Object.hasOwn(creds, active)) return null;
    const credential = creds[active];
    if (!credential || typeof credential !== 'object' || typeof credential.type !== 'string') return null;
    return { sid: payload.sid, sourceId: active, credential, renewedAt: payload.renewedAt };
  }
  if (payload.v === 3) {
    const { v: _v, sid, renewedAt, exp: _exp, ...fields } = payload;
    return { sid, sourceId: legacySourceId, credential: { ...fields, type: legacyType }, renewedAt };
  }
  return null;
}
