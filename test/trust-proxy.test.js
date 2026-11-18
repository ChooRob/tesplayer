import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrustProxy, applyTrustProxy, isHostName, RESOLVE_EVERY_MS } from '../trust-proxy.js';

const dnsOf = table => async name => {
  if (!table[name]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return table[name];
};

test('only names are looked up; addresses, subnets, presets and numbers pass through', () => {
  for (const name of ['caddy', 'app_proxy', 'umbrel-proxy.local', 'a1']) assert.ok(isHostName(name), name);
  for (const other of ['loopback', 'uniquelocal', '172.18.0.2', '172.18.0.0/16', '::1', 'fd00::/8', '1', '10.0.0.0/8']) assert.ok(!isHostName(other), other);
  for (const bad of ['-x', 'a b', 'x/y', 'bad!name']) assert.ok(!isHostName(bad), bad);
});

test('names become addresses, in the order given, next to untouched entries', async () => {
  const lookup = dnsOf({ caddy: [{ address: '172.18.0.2', family: 4 }, { address: 'fd00::2', family: 6 }] });
  assert.deepEqual(await resolveTrustProxy('loopback, caddy ,10.0.0.0/8', { lookup }), ['loopback', '172.18.0.2/32', 'fd00::2/128', '10.0.0.0/8']);
  assert.deepEqual(await resolveTrustProxy('', { lookup }), []);
});

test('a name that does not resolve stops startup without repeating the name', async () => {
  await assert.rejects(resolveTrustProxy('proxy-that-is-missing', { lookup: dnsOf({}) }), error => {
    assert.match(error.message, /TRUST_PROXY names a host that could not be found/);
    assert.ok(!error.message.includes('proxy-that-is-missing'));
    return true;
  });
});

test('names are looked up again every 10 minutes and the setting follows a new address', async t => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  assert.equal(RESOLVE_EVERY_MS, 600000);
  const table = { caddy: [{ address: '172.18.0.2', family: 4 }] };
  const set = [];
  const warnings = [];
  const stop = await applyTrustProxy({ set: (name, value) => set.push([name, value]) }, 'caddy', { lookup: dnsOf(table), warn: message => warnings.push(message) });
  assert.deepEqual(set, [['trust proxy', ['172.18.0.2/32']]]);

  mock.timers.tick(RESOLVE_EVERY_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(set.length, 1, 'nothing changed, nothing set');

  table.caddy = [{ address: '172.18.0.9', family: 4 }];
  mock.timers.tick(RESOLVE_EVERY_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(set.at(-1), ['trust proxy', ['172.18.0.9/32']]);

  delete table.caddy;
  mock.timers.tick(RESOLVE_EVERY_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(set.length, 2, 'a failed lookup keeps the last good address');
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('caddy'));
  stop();
});

test('a list with no names sets once and never refreshes', async t => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const set = [];
  await applyTrustProxy({ set: (name, value) => set.push(value) }, 'loopback,172.18.0.0/16');
  mock.timers.tick(RESOLVE_EVERY_MS * 3);
  assert.deepEqual(set, [['loopback', '172.18.0.0/16']]);
});
