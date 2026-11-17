import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-only-secret-with-at-least-32-characters';
const { parseJellyfinUrl } = await import('../jellyfin-source.js');
const { checkSourceConfig, NOTHING_CONFIGURED, PLEX_EMAIL_FORMAT } = await import('../sources.js');

test('JELLYFIN_URL accepts a server address and rejects anything else', () => {
  assert.equal(parseJellyfinUrl('http://192.168.1.50:8096'), 'http://192.168.1.50:8096');
  assert.equal(parseJellyfinUrl(' https://jellyfin.example.com/ '), 'https://jellyfin.example.com');
  assert.equal(parseJellyfinUrl('https://example.com/jellyfin/'), 'https://example.com/jellyfin', 'a path prefix is allowed');
  for (const bad of ['192.168.1.50:8096', 'jellyfin.local:8096', 'ftp://jellyfin.example.com', 'https://user:secret@jellyfin.example.com',
    'https://jellyfin.example.com/?api_key=x', 'https://jellyfin.example.com/#web', 'not a url', '']) {
    assert.throws(() => parseJellyfinUrl(bad), (error) => {
      assert.match(error.message, /JELLYFIN_URL must be/);
      assert.ok(!error.message.includes('secret'), 'the value is never repeated');
      return true;
    }, bad);
  }
});

const plex = { id: 'plex', type: 'plex' };
const jellyfin = { id: 'jellyfin', type: 'jellyfin' };

test('single tenant: Plex needs PLEX_EMAIL, Jellyfin needs JELLYFIN_URL', () => {
  // The server is found and saved when that account first signs in.
  assert.deepEqual(checkSourceConfig({ PLEX_EMAIL: 'Me@Example.com' }), { configured: [plex], problems: [], warnings: [] });
  assert.deepEqual(checkSourceConfig({ JELLYFIN_URL: 'http://192.168.1.50:8096' }), { configured: [jellyfin], problems: [], warnings: [] });
  assert.deepEqual(checkSourceConfig({ PLEX_EMAIL: 'me@example.com', JELLYFIN_URL: 'https://jf.example' }).configured, [plex, jellyfin]);
  // PLEX_TOKEN is no longer used: it never sets Plex up, and the log says it can go.
  const tokenOnly = checkSourceConfig({ PLEX_TOKEN: 't', JELLYFIN_URL: 'https://jf.example' });
  assert.deepEqual(tokenOnly.configured, [jellyfin]);
  assert.deepEqual(tokenOnly.problems, []);
  assert.match(tokenOnly.warnings[0], /PLEX_TOKEN is no longer used/);
  assert.ok(!tokenOnly.warnings.join().includes("'t'"), 'the value is never repeated');
  // A plugin choosing Plex servers needs nothing set.
  assert.deepEqual(checkSourceConfig({}, [{ resolveServer() {} }]).configured, [plex]);
});

test('each setup error names the setting at fault, and only errors stop sign-in', () => {
  assert.deepEqual(checkSourceConfig({}).problems, [NOTHING_CONFIGURED]);
  assert.deepEqual(checkSourceConfig({ PLEX_TOKEN: 't' }).problems, [NOTHING_CONFIGURED], 'no PLEX_EMAIL and no JELLYFIN_URL');
  for (const bad of ['me', 'me@', '@example.com', 'me@example', 'me @example.com']) {
    assert.deepEqual(checkSourceConfig({ PLEX_EMAIL: bad }).problems, [PLEX_EMAIL_FORMAT], bad);
  }
  assert.deepEqual(checkSourceConfig({ PLEX_EMAIL: 'me@example.com' }, [{ resolveServer() {} }]).configured, [plex]);
  // A bad setting is reported even when the other backend works, which stays usable.
  const badJellyfin = checkSourceConfig({ PLEX_EMAIL: 'me@example.com', JELLYFIN_URL: 'jellyfin.local:8096' });
  assert.deepEqual(badJellyfin.configured, [plex]);
  assert.match(badJellyfin.problems[0], /JELLYFIN_URL must be/);
  const badEmail = checkSourceConfig({ PLEX_EMAIL: 'nope', JELLYFIN_URL: 'https://jf.example' });
  assert.deepEqual(badEmail.configured, [jellyfin]);
  assert.deepEqual(badEmail.problems, [PLEX_EMAIL_FORMAT]);
  assert.ok(!badEmail.problems.join().includes('nope'), 'values are never repeated');
});
