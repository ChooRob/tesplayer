// Captions, shared by the Plex and Jellyfin sources.
//
// A track the server can hand over as text is `kind: 'text'`: the player draws it
// itself and can turn it on or off at once. Anything else (image subtitles, or
// subtitles a server only offers burned into the picture) is `kind: 'burn'`: the
// server draws it into the video, which needs the stream to restart.

// Track IDs are Plex stream IDs (digits) or Jellyfin stream indexes (digits).
export const TRACK_ID = /^[0-9]{1,6}$/;

const MAX_LABEL = 80;
const MAX_TRACKS = 60;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const SUBTITLE_TEXT_LIMIT = MAX_TEXT_BYTES;

// The text subtitle formats the player can show as they are or after conversion.
export const TEXT_FORMATS = new Set(['srt', 'subrip', 'vtt', 'webvtt']);

// ISO 639-2 has two codes for some languages (French is "fre" or "fra"); servers
// disagree, so both become the same one and a remembered choice matches either.
const LANGUAGE_ALIASES = {
  fre: 'fra', ger: 'deu', dut: 'nld', chi: 'zho', cze: 'ces', gre: 'ell', ice: 'isl', mac: 'mkd', may: 'msa',
  per: 'fas', rum: 'ron', slo: 'slk', tib: 'bod', wel: 'cym', arm: 'hye', baq: 'eus', bur: 'mya', geo: 'kat', alb: 'sqi', mao: 'mri',
};

const clean = (value, fallback = '') => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL) : fallback);

// One track as the page sees it: nothing about where it is stored or how to fetch it.
export function describeTrack({ id, label, language, kind, forced = false, isDefault = false }) {
  return {
    id: String(id),
    label: clean(label, 'Subtitles') || 'Subtitles',
    language: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language || '') ? (LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase()) : null,
    kind: kind === 'text' ? 'text' : 'burn',
    forced: !!forced,
    default: !!isDefault,
  };
}

// Text tracks first, then by label, and never more than a sensible number.
export function orderTracks(tracks) {
  return [...tracks].slice(0, MAX_TRACKS).sort((a, b) =>
    (Number(b.kind === 'text') - Number(a.kind === 'text')) || (Number(a.forced) - Number(b.forced)) || a.label.localeCompare(b.label));
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

// SubRip or WebVTT text as WebVTT, which is what the page's parser reads. Cue
// settings and style tags other than a few simple ones are dropped.
export function toWebVtt(text) {
  const source = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = source.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line, index, all) => !(index === 0 && /^\d+$/.test(line.trim()) && all.length > 1));
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = lines[timing].split('-->').map(part => part.trim().split(/\s+/)[0]);
    if (!SRT_TIME.test(from) || !SRT_TIME.test(to)) continue;
    const body = lines.slice(timing + 1).join('\n').trim();
    if (!body) continue;
    cues.push(`${stamp(from)} --> ${stamp(to)}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function stamp(value) {
  const [, h, m, s, ms] = SRT_TIME.exec(value);
  return `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`;
}
