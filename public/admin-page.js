const form = document.getElementById('unlock');
const token = document.getElementById('token');
const usePasskey = document.getElementById('usePasskey');
const enrollment = document.getElementById('enrollment');
const addPasskey = document.getElementById('addPasskey');
const lock = document.getElementById('lock');
const status = document.getElementById('adminStatus');
const nav = document.getElementById('adminTabs');
const panels = document.getElementById('adminPanels');
const auth = '/api/admin/auth';
let busy = false;

async function api(url, { method = 'GET', body, authorization } = {}) {
  const headers = {};
  if (authorization) headers.Authorization = 'Bearer ' + authorization;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (data?.code === 'ADMIN_LOCKED') location.reload();
  if (!response.ok) throw new Error(data?.error || 'Admin request failed.');
  return data;
}

async function showTabs() {
  const { tabs } = await api('/api/admin/tabs');
  form.hidden = true;
  token.value = '';
  lock.hidden = false;
  status.textContent = '';
  nav.hidden = false;
  const entries = tabs.map(({ id, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'tab-' + id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'panel-' + id);
    button.textContent = label;
    const panel = document.createElement('section');
    panel.id = 'panel-' + id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    nav.append(button);
    panels.append(panel);
    return { id, button, panel, loaded: false };
  });

  async function select(entry) {
    for (const item of entries) {
      item.button.setAttribute('aria-selected', String(item === entry));
      item.panel.hidden = item !== entry;
    }
    if (entry.loaded) return;
    entry.loaded = true;
    try {
      const module = await import('/api/admin/tabs/' + encodeURIComponent(entry.id) + '.js');
      await module.mount(entry.panel.attachShadow({ mode: 'open' }));
    } catch {
      entry.panel.textContent = 'This tab could not be loaded. Refresh Admin to try again.';
    }
  }
  for (const entry of entries) entry.button.addEventListener('click', () => void select(entry));
  if (entries.length) await select(entries[0]);
}

async function run(action) {
  if (busy) return;
  busy = true;
  status.textContent = '';
  try { await action(); }
  catch (error) { status.textContent = error.message || 'Admin request failed.'; }
  finally { busy = false; }
}

function enteredToken() {
  const value = token.value.trim();
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('Enter the 64-character admin token.');
  return value;
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (enrollment.hidden) return;
  if (event.submitter?.value === 'register') {
    void run(() => passkey('register'));
  } else {
    void run(async () => {
      await api(auth + '/token', { method: 'POST', authorization: enteredToken() });
      await showTabs();
    });
  }
});

async function passkey(action) {
  const register = action === 'register';
  const authorization = register ? enteredToken() : undefined;
  const endpoint = auth + '/passkeys/' + action;
  const optionsJSON = await api(endpoint + '/options', { method: 'POST', authorization });
  const browser = globalThis.SimpleWebAuthnBrowser;
  const credential = register
    ? await browser.startRegistration({ optionsJSON })
    : await browser.startAuthentication({ optionsJSON });
  await api(endpoint + '/verify', { method: 'POST', authorization, body: credential });
  if (register) {
    token.value = '';
    await loadState();
    status.textContent = 'Passkey added. Unlock Admin with your passkey.';
  } else {
    await showTabs();
  }
}
usePasskey.addEventListener('click', () => void run(() => passkey('authenticate')));
lock.addEventListener('click', () => void run(async () => {
  await api(auth + '/lock', { method: 'POST' });
  location.reload();
}));

async function loadState() {
  const state = await api(auth + '/status');
  if (state.unlocked) return showTabs();
  form.hidden = false;
  const supported = state.passkeysSupported && globalThis.SimpleWebAuthnBrowser?.browserSupportsWebAuthn();
  enrollment.hidden = !state.tokenEnabled;
  addPasskey.hidden = !supported || !state.tokenEnabled;
  usePasskey.hidden = !supported || !state.hasPasskey;
  if (enrollment.hidden && usePasskey.hidden) status.textContent = 'Admin requires an enrolled passkey and a compatible browser.';
}
void run(loadState);
