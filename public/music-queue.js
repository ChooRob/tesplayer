// A play queue for music: the tracks to play, in order, and where in them we are. Plex Web
// builds one when you press Play (an artist: all its tracks shuffled; an album or a playlist:
// its tracks in order; a track: its album from that track on). The browse page makes one the
// same way, from what the source lists, and the player reads it, so it works for any source.
// It is kept in the tab's session storage, because the player is a page per track.

const KEY = 'freeStuffCrazyPlayer.queue';
export const MAX_QUEUE = 3000;

// What the queue keeps of a track: enough to list it and to show what is playing.
export const trackSummary = track => ({
  ratingKey: String(track.ratingKey),
  title: String(track.title ?? ''),
  artist: track.artist ?? null,
  album: track.album ?? null,
  durationMs: track.durationMs ?? null,
  thumbnail: track.thumbnail ?? null,
  episode: track.episode ?? null,
  season: track.season ?? null,
  // A playlist can hold videos among its tracks; the player plays each the way it is (see canvas2.html).
  ...(track.type === 'movie' || track.type === 'episode' ? { video: true } : {}),
});

// Fisher-Yates; `random` is injectable so a test can say which order comes out.
export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const newId = () => Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

// `start` is the index to begin at in the given order; with `shuffle` the whole list is mixed first
// (and begins at its first track, as pressing Play on an artist does).
export function createQueue({ label = '', items, start = 0, shuffle = false, repeat = 'off', radio = null, random = Math.random, id = newId() }) {
  // Each track remembers its place in the original order (`at`), so shuffle can be undone.
  const tracks = items.filter(item => item?.ratingKey != null).slice(0, MAX_QUEUE).map((item, at) => ({ ...trackSummary(item), at }));
  const ordered = shuffle ? shuffled(tracks, random) : tracks;
  const index = shuffle ? 0 : Math.min(Math.max(0, start), Math.max(0, ordered.length - 1));
  // A radio carries what it is made from, so the player can add to it when it runs low.
  const radioArtist = radio && validArtistKey(radio.artistKey) ? { artistKey: String(radio.artistKey) } : null;
  return { id, label: String(label).slice(0, 120), items: ordered, index, shuffled: !!shuffle, repeat: REPEAT_MODES.includes(repeat) ? repeat : 'off', radio: radioArtist };
}

const validArtistKey = key => (typeof key === 'string' || typeof key === 'number') && /^[A-Za-z0-9-]{1,64}$/.test(String(key));

// Repeat: nothing, the whole queue, or the one track.
export const REPEAT_MODES = ['off', 'all', 'one'];
export const nextRepeat = mode => REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length] ?? 'off';

// Turning shuffle on mixes every other track after the one playing (which carries on); turning it off
// puts the tracks back in their original order, still on the same one.
export function shuffleQueue(queue, random = Math.random) {
  const current = queue.items[queue.index];
  if (!current) return { ...queue, shuffled: true };
  const rest = queue.items.filter((_, index) => index !== queue.index);
  return { ...queue, shuffled: true, items: [current, ...shuffled(rest, random)], index: 0 };
}

export function unshuffleQueue(queue) {
  const current = queue.items[queue.index];
  const items = [...queue.items].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { ...queue, shuffled: false, items, index: Math.max(0, items.indexOf(current)) };
}

// Where to go on from the track playing: the next, or at the end the first again if the queue repeats;
// when a track finishes by itself (`auto`) and repeat is on for one track, that same track. null is the end.
export function nextPosition(queue, { auto = false } = {}) {
  if (auto && queue.repeat === 'one' && queue.items.length) return queue.index;
  if (queue.index + 1 < queue.items.length) return queue.index + 1;
  return queue.repeat !== 'off' && queue.items.length ? 0 : null;
}

// A shuffled queue that repeats all goes round again in a new order, not the same one again. This says the step on from
// the end of such a queue (with more than two to mix) is a wrap to the start, which is when it is mixed afresh.
export const wrapsReshuffled = queue => queue.shuffled === true && queue.repeat === 'all' && queue.items.length > 2
  && queue.index === queue.items.length - 1;

// The queue mixed again for the next time round, standing at its first, which is never the one just played.
// Anything else is returned as it was.
export function reshuffledForRepeat(queue, random = Math.random) {
  if (!wrapsReshuffled(queue)) return queue;
  const justPlayed = queue.items[queue.index];
  const items = shuffled(queue.items, random);
  if (items[0].ratingKey === justPlayed.ratingKey) {
    const other = items.findIndex(item => item.ratingKey !== justPlayed.ratingKey);
    if (other > 0) [items[0], items[other]] = [items[other], items[0]];
  }
  return { ...queue, items, index: 0 };
}

export function saveQueue(storage, queue) {
  try { storage.setItem(KEY, JSON.stringify(queue)); return true; } catch { return false; }
}

// The saved queue, if it is the one asked for (an address carries the queue's id) and is well formed.
export function readQueue(storage, id) {
  try {
    const queue = JSON.parse(storage.getItem(KEY) || 'null');
    if (!queue || queue.id !== id || !Array.isArray(queue.items) || !Number.isInteger(queue.index)) return null;
    if (!queue.items.every(item => item && typeof item.ratingKey === 'string')) return null;
    if (!REPEAT_MODES.includes(queue.repeat)) queue.repeat = 'off';
    if (!(queue.radio && validArtistKey(queue.radio.artistKey))) queue.radio = null;
    return queue;
  } catch { return null; }
}

// Where `ratingKey` is: at the saved position if it matches, else the nearest copy of it after that
// position, else any (a playlist can hold a track twice).
export function positionOf(queue, ratingKey) {
  const key = String(ratingKey);
  if (queue.items[queue.index]?.ratingKey === key) return queue.index;
  const after = queue.items.findIndex((item, index) => index > queue.index && item.ratingKey === key);
  return after >= 0 ? after : queue.items.findIndex(item => item.ratingKey === key);
}

// The part of a long queue worth drawing: the current track and a stretch either side.
export function visibleWindow(count, current, { before = 20, after = 200 } = {}) {
  const from = Math.max(0, current - before);
  return { from, to: Math.min(count, current + after + 1) };
}

export const withIndex = (queue, index) => ({ ...queue, index });

// The films of a queue the panel beside the picture lists: `size` of them (40), the playing one with the last few played
// behind it and the rest ahead, however long the queue is. Near either end the window shifts to still hold `size`.
export const QUEUE_WINDOW = 40;
export const QUEUE_WINDOW_BEHIND = 10;
export function queueWindow(count, current, { size = QUEUE_WINDOW, behind = QUEUE_WINDOW_BEHIND } = {}) {
  const from = Math.max(0, Math.min(current - behind, count - size));
  return { from, to: Math.min(count, from + size) };
}

// Begun and not nearly finished: such a film or episode resumes where it was left.
export const isResumable = item => item.viewOffset > 5000 && item.durationMs > 0 && item.viewOffset < item.durationMs - 30000;

// More tracks on the end (a radio topping itself up), each remembering its place in the order. A track
// already in the queue is not added again unless `allowRepeats` (a small library that has run out).
export function appendTracks(queue, tracks, { allowRepeats = false, limit = Infinity } = {}) {
  const have = new Set(allowRepeats ? [] : queue.items.map(item => item.ratingKey));
  let at = Math.max(-1, ...queue.items.map(item => item.at ?? 0)) + 1;
  const added = [];
  for (const track of tracks) {
    if (added.length >= limit) break;
    if (track?.ratingKey == null || have.has(String(track.ratingKey))) continue;
    have.add(String(track.ratingKey));
    added.push({ ...trackSummary(track), at: at++ });
  }
  // Nothing new: the very same queue comes back, so a caller can tell (a queue at its cap stays the same length
  // when tracks are added, as the oldest drop off).
  if (!added.length) return queue;
  // Past the cap, the oldest (already played) go from the front, and the position moves with them.
  const all = [...queue.items, ...added];
  const dropped = Math.max(0, all.length - MAX_QUEUE);
  return { ...queue, items: all.slice(dropped), index: Math.max(0, queue.index - dropped) };
}

// A radio's queue rolls along instead of growing: the tracks played longer ago than the last `keepPlayed` leave the
// front, and tracks from `tracks` go on the end until it holds `size`. The very same queue comes back when
// nothing needed to change, so a caller can tell. (Dropping from the front moves every position down by the
// difference of the two indexes.)
export function rollRadio(queue, tracks, { size, keepPlayed, allowRepeats = false }) {
  const drop = Math.max(0, queue.index - keepPlayed);
  const trimmed = drop ? { ...queue, items: queue.items.slice(drop), index: queue.index - drop } : queue;
  const room = size - trimmed.items.length;
  return room > 0 ? appendTracks(trimmed, tracks, { allowRepeats, limit: room }) : trimmed;
}
