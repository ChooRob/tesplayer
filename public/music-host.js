// Music that keeps playing while you browse: the browse page holds the music player (the full-screen
// screen, a page of its own) in a frame. The player tells the page what is playing, and the page
// can tell it what to do. Messages cross only between this page and its own frame, and only
// the few fields and commands listed here are believed.

export const MUSIC_MESSAGE = 'fsc-music';
export const COMMANDS = new Set(['toggle', 'play', 'pause', 'next', 'previous', 'seek', 'stop']);
const THUMBNAIL = /^\/api\/library\/thumb\?[A-Za-z0-9%&=._~+-]{1,600}$/;
const STATES = new Set(['idle', 'loading', 'buffering', 'playing', 'paused', 'ended', 'error']);

// A message from the frame we hold, from this site.
export const fromFrame = (event, frameWindow, origin) => !!frameWindow && event.source === frameWindow && event.origin === origin;
// A message from the page that holds us, from this site.
export const fromParent = (event, parentWindow, origin) => !!parentWindow && event.source === parentWindow && event.origin === origin;

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const seconds = value => (Number.isFinite(value) && value >= 0 && value < 1e6 ? value : 0);

// What the player says about itself, as the page may use it. null for anything else.
export function cleanState(data) {
  if (!data || data.type !== MUSIC_MESSAGE || data.event !== 'state') return null;
  return {
    state: STATES.has(data.state) ? data.state : 'idle',
    // Whether it is meant to be playing (it may be buffering for a moment): what the play button shows.
    playing: data.playing === true,
    key: /^[A-Za-z0-9-]{1,64}$/.test(String(data.key)) ? String(data.key) : null,
    // The queue it is playing from (its id), so a reloaded page can pick the same list up again.
    queue: typeof data.queue === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(data.queue) ? data.queue : null,
    title: text(data.title, 200),
    artist: text(data.artist, 200),
    album: text(data.album, 200),
    thumbnail: typeof data.thumbnail === 'string' && THUMBNAIL.test(data.thumbnail) ? data.thumbnail : null,
    position: seconds(data.position),
    duration: seconds(data.duration),
    hasNext: data.hasNext === true,
    hasPrevious: data.hasPrevious === true,
    // A skip the player is working on, so the bar shows it even when it was asked for by the steering wheel.
    skipping: data.skipping === 'next' || data.skipping === 'previous' ? data.skipping : null,
  };
}

// A command for the player: one of the listed names, and for seek, a position.
export function cleanCommand(data) {
  if (!data || data.type !== MUSIC_MESSAGE || data.event !== 'command' || !COMMANDS.has(data.name)) return null;
  if (data.name === 'seek') return Number.isFinite(data.seconds) && data.seconds >= 0 && data.seconds < 1e6 ? { name: 'seek', seconds: data.seconds } : null;
  return { name: data.name };
}

// Music carries on while you stay among music: its libraries and playlists. Moving to movies, shows or
// a plugin's tab (Live TV) stops it.
export const keepsMusicPlaying = library => library?.type === 'music' || library?.type === 'playlists';

export const clock = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
