import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SESSION_SECRET ??= 'test-only-secret-with-at-least-32-characters';
const { serverPrompt } = await import('../jellyfin-source.js');

const help = { text: 'Not reachable from the internet with HTTPS?', label: 'Get the connector plugin', url: 'https://github.com/FreeStuffCrazy/jellyfin-plugin-freestuffcrazy' };

test('a plugin can offer a help link with its prompt', () => {
  assert.deepEqual(serverPrompt({ hint: 'Enter your server.', help }).help, { ...help, url: 'https://github.com/FreeStuffCrazy/jellyfin-plugin-freestuffcrazy' });
  assert.deepEqual(serverPrompt({ help }), { hint: undefined, label: undefined, placeholder: undefined, help });
});

test('only a plain https link with both a sentence and a label is offered', () => {
  for (const bad of [
    { ...help, url: 'http://example.com/plugin' },
    { ...help, url: 'javascript:alert(1)' },
    { ...help, url: 'data:text/html,<script>1</script>' },
    { ...help, url: 'https://user:pass@example.com/' },
    { ...help, url: 'not a url' },
    { ...help, url: undefined },
    { ...help, label: '   ' },
    { ...help, text: undefined },
    { ...help, url: `https://example.com/${'a'.repeat(400)}` },
    'a string', 42, null,
  ]) {
    assert.equal(serverPrompt({ hint: 'Enter your server.', help: bad }).help, undefined, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('long help text is shortened and a prompt without help is unchanged', () => {
  const long = serverPrompt({ help: { ...help, text: 'x'.repeat(500), label: 'y'.repeat(500) } }).help;
  assert.equal(long.text.length, 200);
  assert.equal(long.label.length, 60);
  assert.deepEqual(serverPrompt({ hint: 'Enter your server.', label: 'Server', placeholder: 'x' }), { hint: 'Enter your server.', label: 'Server', placeholder: 'x', help: undefined });
  assert.equal(serverPrompt({ help: null }), null);
  assert.equal(serverPrompt(undefined), null);
});

test('the login page shows the help only after a typed address fails, and builds the link safely', () => {
  const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  assert.match(html, /id="jellyfinServerHelp"[^>]*hidden/, 'hidden until an address fails');
  assert.match(html, /if \(address\) showServerHelp\(true\)/, 'only for an address the person typed');
  assert.match(html, /showServerHelp\(false\);\s*\n\s*setStatus\('Contacting Jellyfin…'\)/, 'cleared on every new attempt');
  assert.match(html, /rel = 'noopener noreferrer'/);
  assert.match(html, /parsed\.protocol === 'https:'/, 'the page checks the scheme too');
  const section = html.slice(html.indexOf('function showServerHelp'), html.indexOf('function stopJellyfinPolling'));
  assert.ok(!/innerHTML/.test(section), 'the link is built with DOM calls, never innerHTML');
});
