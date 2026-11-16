import test from 'node:test';
import assert from 'node:assert/strict';
import { createCookieSealer } from '../session-cookie.js';

const secret = 'test-only-secret-with-at-least-32-characters';

test('a sealed cookie opens only with the same secret and purpose, and hides its contents', () => {
  const sealer = createCookieSealer(secret);
  const value = sealer.seal('session', { userToken: 'plex-secret-token', profileId: '20' }, 60000);
  assert.doesNotMatch(value, /plex-secret-token/);
  assert.doesNotMatch(Buffer.from(value.slice(3), 'base64url').toString('latin1'), /plex-secret-token/);
  assert.equal(sealer.open('session', value).userToken, 'plex-secret-token');
  assert.equal(sealer.open('login', value), null);
  assert.equal(createCookieSealer(secret + '-rotated').open('session', value), null);
});

test('tampered, truncated, malformed and expired cookies open as null', () => {
  let time = 1000;
  const sealer = createCookieSealer(secret, { now: () => time });
  const value = sealer.seal('session', { a: 1 }, 500);
  const body = Buffer.from(value.slice(3), 'base64url');
  body[body.length - 20] ^= 1;
  for (const bad of ['v1.' + body.toString('base64url'), value.slice(0, 20), 'v1.', 'v2' + value.slice(2), '', undefined, '%zz']) {
    assert.equal(sealer.open('session', bad), null);
  }
  assert.deepEqual(sealer.open('session', value), { a: 1, exp: 1500 });
  time = 1500;
  assert.equal(sealer.open('session', value), null);
});

test('rejects short secrets', () => {
  assert.throws(() => createCookieSealer('too-short'), /32 characters/);
});
