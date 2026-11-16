import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A linking page sends people to /login?jellyfinServer=<name>: the Jellyfin
// step opens with the name filled in, but nothing is submitted for them.
test('the login page fills in a suggested Jellyfin server without submitting it', () => {
  const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  assert.match(html, /get\('jellyfinServer'\)/);
  assert.match(html, /jellyfinServer\.value = suggestedServer \|\|/);
  assert.match(html, /if \(suggestedServer && jellyfinAsksServer && types\.has\('jellyfin'\)\) jellyfinBtn\.click\(\);/);
  assert.doesNotMatch(html, /startJellyfin\(suggestedServer/, 'the suggestion is never submitted automatically');
});
