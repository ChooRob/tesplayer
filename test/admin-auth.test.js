import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { mkdtempSync, rmSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerAdmin, adminSpec, adminConfigured } from '../admin-auth.js';
import { createJsonStore } from '../storage.js';

const origin = 'https://admin.example.test';
const token = 'a'.repeat(64);
const env = {
  FREESTUFFCRAZY_ADMIN: 'plex:owner@example.test',
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
};

function fixture(t, enrollmentEnabled = false) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tesladash-admin-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  const store = createJsonStore({ dir: dataDir });
  const admin = registerAdmin(app, {
    store, appOrigin: origin, env: { ...env, FREESTUFFCRAZY_ADMIN_ALLOW_TOKEN: String(enrollmentEnabled) },
    rateLimit: () => (_req, _res, next) => next(),
    // Stands in for the signed-in source's getAdminIdentity: a Home profile
    // or a different account is not an admin.
    identityFor: async req => (['home-profile', 'different-owner'].includes(req.get('x-session')) ? null
      : { id: req.get('x-session') === 'jellyfin-admin' ? 'jellyfin:server:user' : 'plex:123', name: 'Owner', sessionId: req.get('x-session') }),
  });
  app.get('/api/admin/example', (req, res) => res.json({ account: req.adminIdentity.id }));
  app.param('id', (_req, res) => res.status(400).json({ error: 'Numeric ID required' }));

  function request(url, { method = 'GET', session = 'owner-session', bearer, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = new IncomingMessage(new Socket());
      req.url = url;
      req.method = method;
      req.headers = { host: 'admin.example.test', 'x-session': session };
      if (bearer) req.headers.authorization = 'Bearer ' + bearer;
      const payload = body === undefined ? null : JSON.stringify(body);
      if (payload) {
        req.headers['content-type'] = 'application/json';
        req.headers['content-length'] = String(Buffer.byteLength(payload));
      }
      const res = new ServerResponse(req);
      res.end = chunk => {
        resolve({ status: res.statusCode, body: chunk ? JSON.parse(chunk.toString()) : null });
        return res;
      };
      app.handle(req, res, reject);
      if (payload) req.push(payload);
      req.push(null);
    });
  }
  return { admin, request, store };
}

test('Admin stays unavailable without tabs and duplicate IDs cannot replace a tab', async t => {
  const { admin, request } = fixture(t);
  const owner = { get: () => 'owner-session' };
  assert.equal(await admin.available(owner), false);
  assert.equal((await request('/api/admin/auth/status')).status, 403);
  assert.equal(admin.registerTab({ id: 'minutes', label: 'Minutes', file: '/minutes.js' }), true);
  assert.equal(admin.registerTab({ id: 'minutes', label: 'Other', file: '/other.js' }), false);
  assert.equal(admin.registerTab({ id: 'logs', label: 'Logs', file: '/logs.js' }), true);
  assert.equal(await admin.available(owner), true);
  assert.equal((await request('/api/admin/tabs', { bearer: token })).body.code, 'ADMIN_LOCKED');
});

function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = randomBytes(24);
  const idString = id.toString('base64url');
  const { x, y } = publicKey.export({ format: 'jwk' });
  const coseKey = isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x, 'base64url')], [-3, Buffer.from(y, 'base64url')],
  ]));
  const authData = (flags, count) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(count);
    return Buffer.concat([createHash('sha256').update('admin.example.test').digest(), Buffer.from([flags]), counter]);
  };
  function clientData(type, challenge, responseOrigin = origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: responseOrigin, crossOrigin: false }));
  }
  const credential = response => ({ id: idString, rawId: idString, type: 'public-key', clientExtensionResults: {}, response });
  return {
    register(challenge) {
      const attestation = isoCBOR.encode(new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', Buffer.concat([authData(0x45, 0), Buffer.alloc(16), Buffer.from([0, id.length]), id, coseKey])],
      ]));
      return credential({
        clientDataJSON: clientData('webauthn.create', challenge).toString('base64url'),
        attestationObject: Buffer.from(attestation).toString('base64url'),
      });
    },
    authenticate(challenge, responseOrigin) {
      const client = clientData('webauthn.get', challenge, responseOrigin);
      const data = authData(0x05, 1);
      return credential({
        clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'),
        signature: sign('sha256', Buffer.concat([data, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
      });
    },
  };
}

test('token unlock is opt-in and passkeys independently authorize an admin session', async t => {
  const disabled = fixture(t);
  disabled.admin.registerTab({ id: 'minutes', label: 'Minutes', file: '/minutes.js' });
  const endpoint = '/api/admin/auth/passkeys/register';
  assert.equal((await disabled.request(endpoint + '/options', { method: 'POST', bearer: token })).status, 403);
  assert.equal((await disabled.request('/api/admin/auth/token', { method: 'POST', bearer: token })).status, 403);

  const { admin, request } = fixture(t, true);
  admin.registerTab({ id: 'minutes', label: 'Minutes', file: '/minutes.js' });
  admin.registerTab({ id: 'usage', label: 'Usage', file: '/usage.js', order: -1 });
  assert.equal((await request(endpoint + '/options', { method: 'POST' })).status, 403);
  const { body: options } = await request(endpoint + '/options', { method: 'POST', bearer: token });
  assert.equal(options.rp.id, 'admin.example.test');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  const key = authenticator();
  assert.equal((await request(endpoint + '/verify', { method: 'POST', bearer: token, body: key.register(options.challenge) })).status, 200);
  assert.equal((await request('/api/admin/auth/status')).body.hasPasskey, true);
  assert.equal((await request('/api/admin/example', { bearer: token })).body.code, 'ADMIN_LOCKED');
  assert.equal((await request('/api/admin/auth/token', { method: 'POST', bearer: token })).status, 200);
  assert.deepEqual((await request('/api/admin/example')).body, { account: 'plex:123' });
  assert.deepEqual((await request('/api/admin/tabs')).body.tabs.map(tab => tab.id), ['usage', 'minutes'], 'a lower order comes first');
  await request('/api/admin/auth/lock', { method: 'POST' });

  const authentication = '/api/admin/auth/passkeys/authenticate';
  const getChallenge = async () => (await request(authentication + '/options', { method: 'POST' })).body.challenge;
  const verify = body => request(authentication + '/verify', { method: 'POST', body });
  assert.equal((await verify(key.authenticate(await getChallenge(), 'https://wrong.example.test'))).status, 400);
  const assertion = key.authenticate(await getChallenge());
  assert.equal((await verify(assertion)).status, 200);
  assert.equal((await verify(assertion)).status, 400);
  assert.deepEqual((await request('/api/admin/example')).body, { account: 'plex:123' });
  for (const session of ['different-owner', 'home-profile']) {
    assert.equal((await request('/api/admin/example', { session, bearer: token })).status, 403);
  }
  assert.equal((await request('/api/admin/example', { session: 'other-owner-session' })).body.code, 'ADMIN_LOCKED');
  await request('/api/admin/auth/lock', { method: 'POST' });
  assert.equal((await request('/api/admin/example')).body.code, 'ADMIN_LOCKED');

  // A Jellyfin administrator is an admin of its own: the Plex admin's passkey
  // isn't theirs, but the admin token unlocks them the same way.
  const jellyfin = { session: 'jellyfin-admin' };
  assert.equal((await request('/api/admin/auth/status', jellyfin)).body.hasPasskey, false);
  assert.equal((await request('/api/admin/auth/token', { ...jellyfin, method: 'POST', bearer: token })).status, 200);
  assert.deepEqual((await request('/api/admin/example', jellyfin)).body, { account: 'jellyfin:server:user' });
});

test('passkeys saved under a bare Plex account ID still belong to that Plex admin', async t => {
  const { admin, request, store } = fixture(t);
  admin.registerTab({ id: 'minutes', label: 'Minutes', file: '/minutes.js' });
  await store.collection('admin-passkeys').set('legacy-key', { id: 'legacy-key', origin, accountId: '123', publicKey: 'x', counter: 0 });
  assert.equal((await request('/api/admin/auth/status')).body.hasPasskey, true);
  assert.equal((await request('/api/admin/auth/status', { session: 'jellyfin-admin' })).body.hasPasskey, false);
});

test('one admin is named by FREESTUFFCRAZY_ADMIN', () => {
  const hash = 'b'.repeat(64);
  assert.deepEqual(adminSpec({ FREESTUFFCRAZY_ADMIN: 'jellyfin:ABC:Sam' }), { type: 'jellyfin', who: 'abc:sam' });
  assert.deepEqual(adminSpec({ FREESTUFFCRAZY_ADMIN: ' plex:Owner@Example.test ' }), { type: 'plex', who: 'owner@example.test' });
  for (const value of ['sam', 'jellyfin:', ':sam', '']) assert.equal(adminSpec({ FREESTUFFCRAZY_ADMIN: value }), null);
  assert.equal(adminConfigured({ FREESTUFFCRAZY_ADMIN: 'jellyfin:sam', FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: hash }), true);
  assert.equal(adminConfigured({ FREESTUFFCRAZY_ADMIN: 'jellyfin:sam' }), false, 'the admin token is still required');
  assert.equal(adminConfigured({ FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: hash }), false, 'nobody is named');
});
