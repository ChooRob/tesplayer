import { clearSavedMusic } from '/saved-music.js';

import { iconEl } from './icons.js';
// Mount a profile badge and switcher in the toolbar.
// The server-held account token allows switching without another login.

function makeAvatar(title, thumb, size) {
  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = title || '';
    img.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;`;
    img.onerror = () => img.replaceWith(makeAvatar(title, null, size));
    return img;
  }
  const fallback = document.createElement('div');
  fallback.textContent = (title || '?').slice(0, 1).toUpperCase();
  fallback.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:#444;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.45)}px;flex-shrink:0;`;
  return fallback;
}

// profiles: whether the signed-in backend has switchable profiles (Plex Home).
// The server this session is on, with what to type to sign in to it, ready
// to copy and share. Plain http pages can't use the clipboard API, so Copy
// falls back to selecting the text.
function serverSection(server) {
  const section = document.createElement('div');
  section.style.cssText = 'margin: 4px auto 20px; max-width: 420px; text-align: left; background: #222; border: 1px solid #333; border-radius: 10px; padding: 14px 16px;';
  const label = document.createElement('div');
  label.textContent = 'Server';
  label.style.cssText = 'color: #999; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px;';
  const name = document.createElement('div');
  name.textContent = server.name || 'Jellyfin server';
  name.style.cssText = 'font-size: 17px; font-weight: 600; color: #fff; word-break: break-word;';
  section.append(label, name);
  if (!server.address) return section;

  const hint = document.createElement('div');
  hint.textContent = 'To sign in to this server, enter:';
  hint.style.cssText = 'color: #999; font-size: 13px; margin: 12px 0 6px;';
  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 8px; align-items: center;';
  const field = document.createElement('input');
  field.type = 'text';
  field.readOnly = true;
  field.value = server.address;
  field.setAttribute('aria-label', 'Server name or address');
  field.style.cssText = 'flex: 1; min-width: 0; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 10px 12px; font: 600 16px ui-monospace, Menlo, Consolas, monospace;';
  field.addEventListener('focus', () => field.select());
  field.addEventListener('click', () => field.select());
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.style.cssText = 'min-height: 44px; padding: 0 16px; border-radius: 6px; border: 1px solid #666; background: #2a2a2a; color: #eee; font: inherit; font-size: 14px; cursor: pointer;';
  const note = document.createElement('div');
  note.setAttribute('aria-live', 'polite');
  note.style.cssText = 'color: #999; font-size: 12px; min-height: 16px; margin-top: 6px;';
  const copied = () => { note.textContent = 'Copied.'; setTimeout(() => { note.textContent = ''; }, 3000); };
  const fallback = () => {
    field.focus();
    field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    if (ok) copied(); else note.textContent = 'Selected. Press Ctrl+C (or ⌘C) to copy.';
  };
  copy.addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(field.value).then(copied, fallback);
    else fallback();
  });
  row.append(field, copy);
  section.append(hint, row, note);
  return section;
}

// A Plex account with more than one server (its own, or shared with it) can move
// between them here, without signing in again. The choice is also remembered for the
// next sign-in on this device if the person asked for that when they signed in.
const SERVER_CHOICE_KEY = 'freeStuffCrazyPlayer.plexServer';
function plexServerSection(server) {
  const section = document.createElement('div');
  section.style.cssText = 'margin: 24px auto 0; max-width: 420px; text-align: left; background: #222; border: 1px solid #333; border-radius: 10px; padding: 14px 16px;';
  const label = document.createElement('div');
  label.textContent = 'Server';
  label.style.cssText = 'color: #999; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px;';
  const name = document.createElement('div');
  name.textContent = server.name;
  name.style.cssText = 'font-size: 17px; font-weight: 600; color: #fff; word-break: break-word;';
  const switchButton = document.createElement('button');
  switchButton.type = 'button';
  switchButton.textContent = 'Switch server';
  switchButton.style.cssText = 'margin-top: 12px; min-height: 44px; padding: 0 16px; border-radius: 6px; border: 1px solid #666; background: #2a2a2a; color: #eee; font: inherit; font-size: 14px; cursor: pointer;';
  const list = document.createElement('div');
  list.style.cssText = 'display: grid; gap: 8px; margin-top: 12px;';
  const message = document.createElement('div');
  message.setAttribute('aria-live', 'polite');
  message.style.cssText = 'color: #999; font-size: 13px; min-height: 16px; margin-top: 8px;';
  const fail = (text) => { message.textContent = text; message.style.color = '#ff6b6b'; };
  section.append(label, name, switchButton, list, message);

  async function choose(chosen) {
    message.textContent = `Switching to ${chosen.name}…`;
    message.style.color = '#999';
    try {
      const res = await fetch('/api/auth/plex/switch-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: chosen.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Switch failed');
      try { if (localStorage.getItem(SERVER_CHOICE_KEY)) localStorage.setItem(SERVER_CHOICE_KEY, chosen.id); } catch { /* not remembered */ }
      // The new server has its own libraries and items, so start at its front page.
      location.href = '/browse';
    } catch (err) {
      fail(err.message);
    }
  }

  switchButton.addEventListener('click', async () => {
    switchButton.disabled = true;
    list.replaceChildren();
    message.textContent = 'Checking your servers…';
    message.style.color = '#999';
    try {
      const res = await fetch('/api/auth/plex/servers', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.servers)) throw new Error(data.error || 'Could not list your servers');
      message.textContent = '';
      for (const entry of data.servers) {
        const current = entry.id === data.current;
        const row = document.createElement('button');
        row.type = 'button';
        row.disabled = current || !entry.online;
        row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center; text-align: left; min-height: 48px; padding: 8px 12px; border-radius: 8px; border: 1px solid #444; background: #1c1c1c; color: #eee; font: inherit; cursor: pointer;' + (row.disabled ? 'opacity: .6; cursor: default;' : '');
        const rowName = document.createElement('span');
        rowName.textContent = entry.name;
        rowName.style.cssText = 'font-weight: 600; word-break: break-word;';
        const who = document.createElement('span');
        who.textContent = entry.owned ? 'Yours' : entry.sharedBy ? `Shared by ${entry.sharedBy}` : 'Shared with you';
        who.style.cssText = 'font-size: 12px; color: #999;';
        const state = document.createElement('span');
        state.textContent = current ? 'Current' : !entry.online ? 'Offline' : entry.relayOnly ? 'Online (slow)' : 'Online';
        state.style.cssText = `grid-row: 1 / span 2; grid-column: 2; font-size: 12px; color: ${!entry.online ? '#ff9a9a' : entry.relayOnly ? '#f2c94c' : '#6fcf97'};`;
        row.append(rowName, who, state);
        row.addEventListener('click', () => choose(entry));
        list.append(row);
      }
    } catch (err) {
      fail(err.message);
    } finally {
      switchButton.disabled = false;
    }
  });
  return section;
}

function openSwitchUserOverlay({ adminAvailable, profiles = true, title: userTitle, source, server }) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, system-ui, sans-serif; color: #eee;
  `;

  const card = document.createElement('div');
  card.style.cssText = `
    background: #181818; border-radius: 14px; padding: 32px;
    width: min(960px, 92vw); max-height: 85vh; overflow-y: auto; text-align: center;
  `;
  overlay.appendChild(card);
  card.style.position = 'relative';

  // Close with the X, Escape, or a tap outside the card.
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeydown);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.style.cssText = 'position:absolute;top:8px;right:8px;width:44px;height:44px;'
    + 'background:none;border:none;border-radius:22px;color:#999;font:inherit;font-size:28px;line-height:1;cursor:pointer;';
  closeButton.addEventListener('click', close);
  card.appendChild(closeButton);

  const title = document.createElement('p');
  title.textContent = profiles ? "Who's watching?" : `Signed in to ${server?.name || source?.name || 'the media server'} as ${userTitle || 'this user'}.`;
  title.style.cssText = 'color: #999; font-size: 14px; margin: 0 0 16px;';
  card.appendChild(title);
  if (server && !profiles) card.appendChild(serverSection(server));

  const grid = document.createElement('div');
  // No profile grid for backends without switchable profiles.
  grid.style.cssText = profiles ? 'display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 20px;' : 'display: none;';
  card.appendChild(grid);
  // Plex only: a Jellyfin session shows its own server section above.
  if (profiles && server?.switchable) card.appendChild(plexServerSection(server));

  const status = document.createElement('div');
  status.style.cssText = 'margin-top: 18px; font-size: 13px; color: #999; min-height: 18px;';
  card.appendChild(status);

  const pinForm = document.createElement('form');
  pinForm.style.cssText = 'display: none; margin-top: 16px;';
  const pinInput = document.createElement('input');
  pinInput.type = 'password';
  pinInput.inputMode = 'numeric';
  pinInput.maxLength = 4;
  pinInput.placeholder = 'PIN';
  pinInput.style.cssText = 'background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:6px;padding:10px 12px;font-size:18px;width:120px;text-align:center;letter-spacing:4px;';
  const pinSubmit = document.createElement('button');
  pinSubmit.type = 'submit';
  pinSubmit.textContent = 'Go';
  pinSubmit.style.cssText = 'background:#e5a00d;color:#111;border:none;border-radius:6px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer;margin-left:8px;';
  pinForm.appendChild(pinInput);
  pinForm.appendChild(pinSubmit);
  card.appendChild(pinForm);

  if (adminAvailable) {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.textContent = 'Admin';
    adminLink.style.cssText = 'display:inline-block;margin-top:20px;padding:10px 16px;border:1px solid #666;border-radius:8px;color:#eee;text-decoration:none;';
    card.appendChild(adminLink);
  }

  const logoutLink = document.createElement('button');
  logoutLink.type = 'button';
  logoutLink.textContent = 'Log out';
  logoutLink.style.cssText = 'display:block;margin:24px auto 0;background:none;border:none;color:#999;font-size:13px;text-decoration:underline;cursor:pointer;font-family:inherit;';
  logoutLink.addEventListener('click', async () => {
    status.textContent = 'Logging out…';
    status.style.color = '#999';
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      clearSavedMusic(); // the music kept for reopening the app is this person's, and they have left
      location.href = '/login.html';
    } catch (err) {
      status.textContent = `Logout failed: ${err.message}`;
      status.style.color = '#ff6b6b';
    }
  });
  card.appendChild(logoutLink);

  // Signs out every browser and car using this Plex account. Needs a second
  // tap, since it also stops playback on the other devices.
  const logoutEverywhere = document.createElement('button');
  logoutEverywhere.type = 'button';
  logoutEverywhere.textContent = 'Log out on all devices';
  logoutEverywhere.style.cssText = logoutLink.style.cssText.replace('margin:24px auto 0', 'margin:12px auto 0');
  let confirmTimer = null;
  logoutEverywhere.addEventListener('click', async () => {
    if (!confirmTimer) {
      logoutEverywhere.textContent = 'Tap again to log out everywhere';
      confirmTimer = setTimeout(() => { confirmTimer = null; logoutEverywhere.textContent = 'Log out on all devices'; }, 5000);
      return;
    }
    clearTimeout(confirmTimer);
    status.textContent = 'Logging out everywhere…';
    status.style.color = '#999';
    try {
      const res = await fetch('/api/auth/logout-everywhere', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 401) throw new Error(data.error || `HTTP ${res.status}`);
      clearSavedMusic();
      location.href = '/login.html';
    } catch (err) {
      confirmTimer = null;
      logoutEverywhere.textContent = 'Log out on all devices';
      status.textContent = `Logout failed: ${err.message}`;
      status.style.color = '#ff6b6b';
    }
  });
  card.appendChild(logoutEverywhere);

  document.body.appendChild(overlay);

  let selectedUser = null;

  async function selectUser(user, pin) {
    status.textContent = 'Switching…';
    status.style.color = '#999';
    try {
      const res = await fetch('/api/auth/switch-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, pin }),
      });
      const data = await res.json();
      if (data.ok) {
        clearSavedMusic(); // another profile: not the music the last one had on
        location.reload();
      } else {
        status.textContent = data.error || 'Switch failed';
        status.style.color = '#ff6b6b';
      }
    } catch (err) {
      status.textContent = `Switch failed: ${err.message}`;
      status.style.color = '#ff6b6b';
    }
  }

  pinForm.onsubmit = (ev) => {
    ev.preventDefault();
    if (selectedUser) selectUser(selectedUser, pinInput.value.trim());
  };

  if (profiles) fetch('/api/auth/home-users')
    .then((res) => res.json())
    .then((users) => {
      if (!Array.isArray(users)) throw new Error(users.error || 'Failed to load users');
      for (const user of users) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.style.cssText = 'cursor:pointer;background:none;border:none;color:#eee;font-family:inherit;padding:0;';
        tile.appendChild(makeAvatar(user.title, user.thumb, 72));
        const label = document.createElement('div');
        label.textContent = user.title;
        if (user.protected) label.append(' ', iconEl('lock'));
        label.style.cssText = 'font-size:13px;margin-top:8px;line-height:1.3;word-break:break-word;';
        tile.appendChild(label);
        tile.addEventListener('click', () => {
          selectedUser = user;
          if (user.protected) {
            pinForm.style.display = 'block';
            pinInput.value = '';
            pinInput.focus();
          } else {
            selectUser(user);
          }
        });
        grid.appendChild(tile);
      }
    })
    .catch((err) => {
      status.textContent = `Failed to load users: ${err.message}`;
      status.style.color = '#ff6b6b';
    });
}

// Copy text to the clipboard. The clipboard API needs a secure page, so fall
// back to selecting a hidden field for plain-HTTP development and old browsers.
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* try the fallback */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.append(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* not allowed */ }
  field.remove();
  return copied;
}

function showWatchTime(quota, updateBadge, accountId) {
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'width:min(380px,90vw);padding:24px;background:#181818;color:#eee;border:1px solid #555;border-radius:14px;font-family:system-ui,sans-serif;';
  const title = document.createElement('h2');
  title.id = 'watchTimeTitle';
  title.textContent = 'Watch time left';
  title.style.cssText = 'margin:0;font-size:18px;';
  dialog.setAttribute('aria-labelledby', title.id);
  const breakdown = document.createElement('dl');
  breakdown.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:12px 24px;margin:20px 0;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'background:#282828;color:#eee;border:1px solid #666;border-radius:8px;min-height:44px;padding:8px 14px;cursor:pointer;';
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  // The ID an administrator needs to add watch time or streams for this account.
  const idBox = document.createElement('div');
  idBox.style.cssText = 'margin:0 0 20px;padding-top:16px;border-top:1px solid #444;';
  const idLabel = document.createElement('div');
  idLabel.textContent = 'Your account ID';
  idLabel.style.cssText = 'font-size:13px;color:#bbb;margin-bottom:8px;';
  const idRow = document.createElement('div');
  idRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const idText = document.createElement('code');
  idText.style.cssText = 'flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow-x:auto;user-select:all;background:#0f0f0f;border:1px solid #444;border-radius:8px;padding:8px 10px;';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.style.cssText = 'flex-shrink:0;background:#282828;color:#eee;border:1px solid #666;border-radius:8px;min-height:44px;padding:8px 14px;cursor:pointer;';
  let copyTimer = null;
  copy.addEventListener('click', async () => {
    const ok = await copyText(idText.textContent);
    copy.textContent = ok ? 'Copied' : 'Press and hold to copy';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });
  const idHelp = document.createElement('div');
  idHelp.textContent = 'Post or send this to ask for more watch time or streams. It is safe to share: it is a code, not your account details.';
  idHelp.style.cssText = 'font-size:12px;color:#999;margin-top:8px;';
  idRow.append(idText, copy);
  idBox.append(idLabel, idRow, idHelp);
  function showAccountId(id) {
    idBox.hidden = typeof id !== 'string' || !id;
    if (!idBox.hidden) idText.textContent = id;
  }
  showAccountId(accountId);
  dialog.append(title, breakdown, idBox, close);

  function render(time) {
    // The plugin names its own rows; core only adds the total.
    const entries = (time.breakdown || []).map(row => [row.label, row.seconds]);
    entries.push(['Total', time.remainingSeconds]);
    breakdown.replaceChildren();
    for (const [label, seconds] of entries) {
      const term = document.createElement('dt');
      const value = document.createElement('dd');
      term.textContent = label;
      value.textContent = (Math.max(0, seconds) / 60).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' min';
      value.style.cssText = 'margin:0;text-align:right;';
      breakdown.append(term, value);
    }
  }

  render(quota);
  document.body.append(dialog);
  dialog.showModal();
  fetch('/api/auth/me', { cache: 'no-store' })
    .then(res => res.ok ? res.json() : null)
    .then(user => {
      if (!Number.isFinite(user?.quota?.remainingSeconds)) return;
      if (dialog.open) { render(user.quota); showAccountId(user.accountId); }
      updateBadge(user.quota);
    })
    .catch(() => {});
}

export async function mountUserBadge(container, { prepend = true } = {}) {
  let user = null;
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) user = await res.json();
  } catch {
    return;
  }
  if (!user) return;

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;background:#222;border:1px solid #444;border-radius:20px;color:#eee;font-family:system-ui,sans-serif;';
  const badge = document.createElement('button');
  badge.id = 'userBadge';
  badge.type = 'button';
  badge.title = 'Switch user';
  badge.style.cssText = `
    display: flex; align-items: center; gap: 8px;
    background: none; border: 0; border-radius: 20px; min-height: 36px;
    padding: 5px 10px 5px 5px; color: inherit; font-family: inherit;
    font-size: 13px; cursor: pointer;
  `;
  badge.appendChild(makeAvatar(user.title, user.thumb, 26));
  const label = document.createElement('span');
  label.className = 'userBadgeName';
  label.textContent = user.title || 'Signed in';
  badge.appendChild(label);
  // Phones show only the avatar; the name stays available to screen readers.
  if (!document.getElementById('userBadgeStyle')) {
    const style = document.createElement('style');
    style.id = 'userBadgeStyle';
    style.textContent = '@media (max-width: 600px) {'
      + ' .userBadgeName { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }'
      + ' #userBadge { padding: 4px !important; min-height: 44px !important; min-width: 44px; justify-content: center; } }';
    document.head.appendChild(style);
  }
  toolbar.appendChild(badge);

  // Only present if a plugin reports a quota.
  if (user.quota && Number.isFinite(user.quota.remainingSeconds)) {
    const quotaButton = document.createElement('button');
    quotaButton.type = 'button';
    quotaButton.title = 'Watch-time breakdown';
    quotaButton.setAttribute('aria-haspopup', 'dialog');
    quotaButton.style.cssText = 'color:#ccc;font:inherit;font-size:11px;background:none;border:0;border-radius:0 20px 20px 0;min-height:36px;padding:0 12px;cursor:pointer;';
    const quotaLabel = document.createElement('span');
    quotaLabel.style.cssText = 'border-left:1px solid #555;padding-left:10px;margin-left:-10px;';
    quotaButton.appendChild(quotaLabel);
    let quota = user.quota;
    const updateQuota = next => {
      quota = next;
      quotaLabel.textContent = Math.max(0, Math.round(quota.remainingSeconds / 60)) + ' min left';
    };
    updateQuota(quota);
    quotaButton.addEventListener('click', () => showWatchTime(quota, updateQuota, user.accountId));
    toolbar.appendChild(quotaButton);
  }

  badge.addEventListener('click', () => openSwitchUserOverlay(user));

  if (prepend && container.firstChild) container.insertBefore(toolbar, container.firstChild);
  else container.appendChild(toolbar);
}
