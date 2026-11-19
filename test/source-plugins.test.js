import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-only-secret-with-at-least-32-characters';
const { checkSourceConfig, createSources, sourceProblems, LIBRARY_METHODS, SIGN_IN_PAGE } = await import('../sources.js');

// The smallest source that meets the contract: what PLUGIN_DEVELOPMENT.md's
// "Writing a source" example does, with nothing behind it.
const noop = () => {};
function minimalSource({ id, options }) {
  const sessions = new Map();
  return {
    id, type: 'minimal', name: 'Minimal', options,
    isValidId: value => typeof value === 'string' && /^[a-z0-9]{1,32}$/.test(value),
    signInOptions: { signInPage: '/minimal/sign-in', signInLabel: 'Sign in to Minimal' },
    auth: {
      loadSession: (_req, _res, next) => next(),
      requireAuth: (_req, _res, next) => next(),
      getSessionId: () => null, getSessionUser: () => null, getSessionProfileId: () => null,
      getSessionAccountId: async () => null, getSessionAccountKey: async () => null,
      clearSession: noop, signOutEverywhere: async () => sessions.clear(),
    },
    registerRoutes: noop,
    library: () => Object.fromEntries(LIBRARY_METHODS.map(name => [name, async () => []])),
    sendThumbnail: (_req, res) => res.status(404).end(),
    watchState: { reportProgress: async () => {}, markWatched: async () => {}, markUnwatched: async () => {} },
    playback: { start: async () => {}, proxy: noop, stop: async () => {}, directCapable: () => false, mediaOrigin: () => '' },
  };
}
const plugin = (configure = env => (env.MINIMAL_URL ? { url: env.MINIMAL_URL } : null)) => ({ sources: { minimal: { configure, create: minimalSource } } });

test('a plugin source is set up when its configure() says so, and not otherwise', () => {
  assert.deepEqual(checkSourceConfig({}, [plugin()]).configured, []);
  assert.deepEqual(checkSourceConfig({ MINIMAL_URL: 'http://m' }, [plugin()]), { configured: [{ id: 'minimal', type: 'minimal', url: 'http://m' }], problems: [], warnings: [] });
  // `true` means set up, with no options.
  assert.deepEqual(checkSourceConfig({}, [plugin(() => true)]).configured, [{ id: 'minimal', type: 'minimal' }]);
  // Built-in sources and plugin sources work side by side, built-ins first.
  assert.deepEqual(checkSourceConfig({ PLEX_EMAIL: 'me@example.com', MINIMAL_URL: 'http://m' }, [plugin()]).configured.map(source => source.id), ['plex', 'minimal']);
});

test('Plex and Jellyfin are bundled source plugins, and configure() and warnings() are given what they need', () => {
  const seen = [];
  const watching = { sources: { minimal: { create: minimalSource, configure: (env, context) => { seen.push(context.plugins); return null; }, warnings: () => ['MINIMAL_OLD is no longer used.'] } } };
  const result = checkSourceConfig({ PLEX_TOKEN: 'x', PLEX_EMAIL: 'me@example.com' }, [watching]);
  assert.deepEqual(result.configured, [{ id: 'plex', type: 'plex' }]);
  assert.deepEqual(result.warnings.map(text => text.split(' ')[0]), ['PLEX_TOKEN', 'MINIMAL_OLD']);
  assert.deepEqual(seen, [[watching]], 'configure receives the loaded plugins');
});

test('a configure() that throws shows its message as a setup problem and stops nothing else', () => {
  const broken = plugin(() => { throw new Error('MINIMAL_URL must be an address.'); });
  const result = checkSourceConfig({ JELLYFIN_URL: 'http://192.168.1.50:8096' }, [broken]);
  assert.deepEqual(result.problems, ['MINIMAL_URL must be an address.']);
  assert.deepEqual(result.configured.map(source => source.id), ['jellyfin']);
});

test('createSources builds a plugin source with its options and checks the contract', async () => {
  const configured = checkSourceConfig({ MINIMAL_URL: 'http://m' }, [plugin()]).configured;
  const sources = await createSources({ plugins: [plugin()], configured, context: {} });
  assert.equal(sources.get('minimal').options.url, 'http://m');
  assert.deepEqual(sourceProblems(sources.get('minimal'), { id: 'minimal', type: 'minimal' }), []);
});

test('a source that falls short is refused with every shortfall named', async () => {
  const lacking = { sources: { thin: { configure: () => true, create: ({ id }) => ({ id, type: 'thin', name: 'Thin', auth: {}, playback: { start: noop } }) } } };
  await assert.rejects(
    createSources({ plugins: [lacking], configured: [{ id: 'thin', type: 'thin' }], context: {} }),
    error => {
      assert.match(error.message, /thin source does not match the source contract/);
      for (const missing of ['isValidId must be a function', 'library must be a function', 'auth.loadSession must be a function', 'watchState must be an object', 'playback.proxy must be a function']) {
        assert.ok(error.message.includes(missing), missing);
      }
      return true;
    });
  assert.deepEqual(sourceProblems(null), ['the factory must return an object']);
  assert.match(sourceProblems({ ...minimalSource({ id: 'a' }), type: 'other' }, { id: 'a', type: 'minimal' })[0], /type must be "minimal"/);
});

test('source types are checked: names, duplicates, built-ins and factories', () => {
  const bad = sources => () => checkSourceConfig({}, [{ sources }]);
  assert.throws(bad({ 'Not Valid': { create: noop } }), /Invalid source type/);
  assert.throws(bad({ plex: { create: noop } }), /Duplicate source type plex/);
  assert.throws(bad({ minimal: { configure: noop } }), /Invalid source factory/);
  assert.throws(bad({ minimal: { create: noop, configure: 'yes' } }), /Invalid source factory/);
  assert.throws(() => checkSourceConfig({}, [plugin(), plugin()]), /Duplicate source type minimal/);
});

test('a plugin source\'s sign-in page must be a path on this site', () => {
  for (const good of ['/minimal/sign-in', '/a', '/a/b_c.d~e']) assert.ok(SIGN_IN_PAGE.test(good), good);
  for (const bad of ['//evil.example', 'https://evil.example/x', 'minimal/sign-in', '/a b', '/a?x=1', '/a\\b', '/<script>']) assert.ok(!SIGN_IN_PAGE.test(bad), bad);
  const source = { ...minimalSource({ id: 'minimal' }), signInOptions: { signInPage: '//evil.example' } };
  assert.match(sourceProblems(source)[0], /signInPage must be a path/);
  const missing = { ...minimalSource({ id: 'minimal' }) };
  delete missing.signInOptions;
  assert.match(sourceProblems(missing, { id: 'minimal', type: 'minimal' })[0], /signInPage is required/);
});
