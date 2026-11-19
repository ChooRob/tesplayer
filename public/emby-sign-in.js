// Signs in to Emby: which server first when the site lets people use their own
// (an address), then a username and password, then the library.
const $ = id => document.getElementById(id);
const status = $('status');
const SERVER_KEY = 'freeStuffCrazyPlayer.embyServer';

function say(text, error = false) {
  status.className = error ? 'error' : '';
  status.textContent = text;
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function showPassword(serverName) {
  $('serverForm').hidden = true;
  $('form').hidden = false;
  $('signInHint').textContent = serverName ? `Sign in to ${serverName} with your Emby username and password.` : 'Use your Emby username and password.';
  $('username').focus();
}

async function begin() {
  let options = null;
  try {
    const sources = await (await fetch('/api/auth/sources')).json();
    options = sources.find(source => source.type === 'emby') || null;
  } catch { /* the password form still works for the configured server */ }
  if (!options?.askServer) { showPassword(null); return; }

  // The site lets people use their own server: ask which one first. The plugin may word the question.
  const prompt = options.serverPrompt || {};
  if (prompt.hint) $('serverHint').textContent = options.serverRequired ? prompt.hint : `${prompt.hint} Or leave it empty to use this site's own Emby server.`;
  else if (!options.serverRequired) $('serverHint').textContent = "Enter your Emby server's https:// address, or leave it empty to use this site's own Emby server.";
  if (prompt.label) $('serverLabel').textContent = prompt.label;
  if (prompt.placeholder) $('server').placeholder = prompt.placeholder;
  $('server').required = !!options.serverRequired;
  try { $('server').value = localStorage.getItem(SERVER_KEY) || ''; } catch { /* nothing remembered */ }
  $('serverForm').hidden = false;
  $('server').focus();
}

$('serverForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('serverSubmit').disabled = true;
  say('Connecting…');
  try {
    const address = $('server').value.trim();
    const { serverName } = await post('/api/auth/emby/start', { server: address });
    try { if (address) localStorage.setItem(SERVER_KEY, address); else localStorage.removeItem(SERVER_KEY); } catch { /* not remembered */ }
    say('');
    $('back').hidden = false;
    showPassword(serverName);
  } catch (error) {
    say(error.message, true);
  } finally {
    $('serverSubmit').disabled = false;
  }
});

$('back').addEventListener('click', () => {
  $('form').hidden = true;
  $('back').hidden = true;
  $('serverForm').hidden = false;
  say('');
  $('server').focus();
});

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  $('submit').disabled = true;
  say('Signing in…');
  try {
    await post('/api/auth/emby/password', { username: $('username').value, password: $('password').value });
    location.replace('/browse');
  } catch (error) {
    say(error.message, true);
    $('submit').disabled = false;
  }
});

begin();
