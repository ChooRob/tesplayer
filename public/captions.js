// Captions in the player.
//
// The server lists an item's subtitle tracks (see subtitles.js). A `text` track is
// fetched as WebVTT and drawn here, so it turns on and off at once; a `burn`
// track is drawn into the video by the server, so choosing one restarts the
// stream (the page does that). This file holds what both players share: reading
// WebVTT, choosing a track from what the viewer chose last time, and drawing the
// text over the picture.

const PREFERENCE_KEY = 'freeStuffCrazyPlayer.captions';

// ---- Reading WebVTT ----

const TIME = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

function seconds(value) {
  const match = TIME.exec(value);
  if (!match) return null;
  const [, h = '0', m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" };

// Cue text as plain lines: tags removed, a few entities decoded, never markup.
function plainText(raw) {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|nbsp|quot|#39);/g, entity => ENTITIES[entity])
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

// WebVTT (or SubRip) text as cues, sorted by start time.
export function parseVtt(text) {
  const blocks = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->').map(part => part.trim().split(/\s+/)[0]);
    const start = seconds(from);
    const end = seconds(to);
    if (start === null || end === null || end <= start) continue;
    const body = plainText(lines.slice(at + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// The text to show at a moment: every cue that has started and not ended.
export function activeText(cues, time) {
  const shown = [];
  // Cues are sorted by start, so stop looking once they begin after `time`.
  for (const cue of cues) {
    if (cue.start > time) break;
    if (time < cue.end) shown.push(cue.text);
  }
  return shown.join('\n');
}

// ---- What the viewer chose last time ----

// { off: true } for "Off", { language: 'en' } for a language, or null for never chosen.
export function readPreference(storage = globalThis.localStorage) {
  try {
    const stored = JSON.parse(storage.getItem(PREFERENCE_KEY) || 'null');
    if (stored?.off === true) return { off: true };
    if (typeof stored?.language === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(stored.language)) return { language: stored.language };
  } catch { /* nothing remembered */ }
  return null;
}

export function writePreference(preference, storage = globalThis.localStorage) {
  try {
    if (!preference) storage.removeItem(PREFERENCE_KEY);
    else storage.setItem(PREFERENCE_KEY, JSON.stringify(preference.off ? { off: true } : { language: preference.language }));
  } catch { /* not remembered */ }
}

// The preference a chosen track stands for: a language, or Off.
export const preferenceFor = track => (track ? (track.language ? { language: track.language } : null) : { off: true });

// The track to turn on at the start, or null. Only a language the viewer chose before
// turns captions on by themselves; a full track beats a "forced" one (foreign-language
// parts only), and a text track beats one the server must draw.
export function pickTrack(tracks, preference) {
  if (!preference || preference.off || !preference.language) return null;
  const base = preference.language.split('-')[0];
  const matches = tracks.filter(track => track.language && track.language.split('-')[0] === base);
  const rank = track => (track.forced ? 2 : 0) + (track.kind === 'text' ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b))[0] || null;
}

// ---- Drawing ----

// Text over the picture, kept to the picture's own box (it can be moved and resized).
// `box()` gives the picture's rectangle; `lift()` how many pixels to raise the text
// to clear the player bar while that is showing.
export function createCaptionLayer({ box, lift = () => 0, doc = document }) {
  const layer = doc.createElement('div');
  layer.id = 'captionLayer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;display:flex;justify-content:center;pointer-events:none;z-index:4;';
  const line = doc.createElement('div');
  line.style.cssText = 'max-width:92%;text-align:center;color:#fff;background:rgba(0,0,0,.72);padding:.12em .5em;border-radius:4px;white-space:pre-line;line-height:1.3;font-family:-apple-system,system-ui,sans-serif;text-shadow:0 1px 2px #000;';
  layer.hidden = true;
  layer.append(line);
  doc.body.append(layer);
  let cues = [];
  let last = null;
  const place = () => {
    const rect = box();
    if (!rect || !rect.width || !rect.height) return;
    const bottom = Math.max(0, (doc.defaultView?.innerHeight ?? 0) - rect.bottom) + rect.height * 0.07 + lift();
    layer.style.left = `${rect.left}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.bottom = `${bottom}px`;
    line.style.fontSize = `${Math.max(16, rect.height * 0.045)}px`;
  };
  return {
    set(newCues) { cues = newCues || []; last = null; line.textContent = ''; layer.hidden = true; },
    clear() { this.set([]); },
    // Call as often as is convenient with the current playback time in seconds.
    update(time) {
      const text = cues.length ? activeText(cues, time) : '';
      if (text !== last) {
        last = text;
        line.textContent = text;
        layer.hidden = !text;
      }
      if (text) place();
    },
  };
}
