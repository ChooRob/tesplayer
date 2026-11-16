export const PLAYBACK_MODES = ['canvas', 'standard'];
export const PLAYBACK_STORAGE_KEY = 'freeStuffCrazyPlayer.playbackMode';

// Phones and tablets play HLS natively (hardware decoding, lock screen,
// AirPlay, native fullscreen), so they default to Standard. Everything else,
// including Tesla's browser (whose user agent looks like desktop Linux),
// defaults to Canvas. A saved choice always wins.
export function isHandheld(env = globalThis) {
  const userAgent = env.navigator?.userAgent || '';
  return /iPhone|iPad|iPod|Android/i.test(userAgent)
    || (/Macintosh/.test(userAgent) && env.navigator?.maxTouchPoints > 1); // iPadOS reports as a Mac
}

export function readPlaybackMode(storage, { handheld = false } = {}) {
  const fallback = handheld ? 'standard' : 'canvas';
  try {
    const mode = storage.getItem(PLAYBACK_STORAGE_KEY);
    return PLAYBACK_MODES.includes(mode) ? mode : fallback;
  } catch { return fallback; }
}

export function canvasSupport(env = globalThis) {
  if (!env.isSecureContext) return 'Canvas playback requires HTTPS or localhost.';
  if (!env.crossOriginIsolated || typeof env.SharedArrayBuffer !== 'function') {
    return 'Canvas playback requires cross-origin isolation.';
  }
  if (typeof env.VideoDecoder !== 'function' || typeof env.AudioDecoder !== 'function') {
    return 'This browser does not support the video and audio decoders needed for Canvas.';
  }
  if (typeof env.AudioWorkletNode !== 'function' || !(env.AudioContext || env.webkitAudioContext)) {
    return 'This browser does not support the audio output needed for Canvas.';
  }
  return '';
}

// Canvas never falls back on its own, except over plain HTTP: browsers only
// offer its decoders on secure pages, so there it is turned off outright.
export function choosePlaybackMode(preference, { canvasError = '', standardSupported = false, secure = true } = {}) {
  if (preference === 'standard' || !secure) return { mode: 'standard', error: standardSupported ? '' : 'Standard playback is not supported by this browser for this source.' };
  return { mode: 'canvas', error: canvasError };
}
