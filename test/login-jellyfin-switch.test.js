import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const handler = id => {
  const start = html.indexOf(`getElementById('${id}').addEventListener('click'`) >= 0
    ? html.indexOf(`getElementById('${id}').addEventListener('click'`)
    : html.indexOf(`${id.replace(/^jellyfin/, 'jellyfin')}.addEventListener('click'`);
  assert.ok(start > 0, `${id} has a click handler`);
  return html.slice(start, html.indexOf('});', start));
};

test('Quick Connect offers a username and password instead, on the same server', () => {
  assert.match(html, /id="jellyfinCodeStep"[\s\S]*?id="jellyfinUsePassword"[\s\S]*?<\/div>/, 'the button sits under the code');
  const usePassword = handler('jellyfinUsePassword');
  assert.match(usePassword, /stopJellyfinPolling\(\)/, 'stops waiting for approval');
  assert.match(usePassword, /jellyfinPasswordForm\.hidden = false/);
  assert.doesNotMatch(usePassword, /startJellyfin|fetch\(/, 'no new sign-in is started: the password goes to the same pending server');
});

test('the password form can go back to Quick Connect, resuming the same code', () => {
  const useQuickConnect = handler('jellyfinUseQuickConnect');
  assert.match(useQuickConnect, /jellyfinCodeStep\.hidden = false/);
  assert.match(useQuickConnect, /pollJellyfin\(\)/);
  // When Quick Connect is off on the server, the password form has no way back to it.
  assert.match(html, /jellyfinPasswordForm\.hidden = false;\n\s*jellyfinUseQuickConnect\.hidden = true;/);
});
