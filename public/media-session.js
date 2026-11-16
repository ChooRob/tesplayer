// Connect playback to the browser's own media controls (media keys, the
// system media panel, headset and Bluetooth buttons) through the Media
// Session API. Everything here is optional: browsers without the API, or
// without one of its actions, simply get no controls.

const SKIP_SECONDS = 30;
const POSITION_INTERVAL_MS = 5000;

// One second of 8 kHz, 8-bit mono silence as a WAV file.
function silentWav() {
  const samples = 8000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit audio is unsigned, so 128 is silence.
  return new Blob([bytes], { type: 'audio/wav' });
}

// Chrome only shows media controls for a page that is playing a media
// element. The Canvas player plays its sound through Web Audio instead, so
// it plays a silent looping clip alongside to keep the controls available.
function createSilentAudio(document) {
  const audio = document.createElement('audio');
  audio.loop = true;
  audio.src = URL.createObjectURL(silentWav());
  return {
    play() { audio.play().catch(() => {}); },
    isPlaying() { return !audio.paused; },
    restart() { audio.pause(); audio.load?.(); audio.play().catch(() => {}); },
    pause() { audio.pause(); },
    dispose() { audio.pause(); URL.revokeObjectURL(audio.src); audio.removeAttribute('src'); },
  };
}

export function createMediaSession({
  actions, isLive = false, keepAlive = false, onAction = null,
  mediaSession = globalThis.navigator?.mediaSession,
  MediaMetadataClass = globalThis.MediaMetadata,
  document = globalThis.document,
  now = () => Date.now(),
}) {
  if (!mediaSession) return { setMetadata() {}, update() {}, dispose() {}, silentClipPlaying() { return null; }, restartSilentClip() {} };

  let lastState = null;
  const silence = keepAlive && document ? createSilentAudio(document) : null;
  const handlers = {
    play: () => { onAction?.('play'); actions.play(); },
    // The car's browser keeps seeing the silent clip play, so it sends Pause for
    // every press of the wheel button. While we are paused, treat Pause as a toggle.
    pause: () => {
      onAction?.('pause');
      if (lastState === 'paused') actions.play(); else actions.pause();
    },
  };
  if (!isLive) {
    handlers.seekbackward = (details) => actions.seekBy(-(details?.seekOffset || SKIP_SECONDS));
    handlers.seekforward = (details) => actions.seekBy(details?.seekOffset || SKIP_SECONDS);
    // Some headsets and keyboards send Next and Previous instead. (The Tesla's
    // panel keeps its own Next and Previous greyed out for web pages either way.)
    handlers.nexttrack = () => actions.seekBy(SKIP_SECONDS);
    handlers.previoustrack = () => actions.seekBy(-SKIP_SECONDS);
    handlers.seekto = (details) => { if (Number.isFinite(details?.seekTime)) actions.seekTo(details.seekTime); };
  }
  function registerHandlers() {
    for (const [action, handler] of Object.entries(handlers)) {
      // play and pause already report themselves above; count the rest here.
      const counted = action === 'play' || action === 'pause' ? handler : (details) => { onAction?.(action); return handler(details); };
      try { mediaSession.setActionHandler(action, counted); } catch { /* not supported here */ }
    }
  }
  registerHandlers();

  let lastPositionAt = -Infinity;

  return {
    // For diagnostics: is the silent clip really playing right now?
    silentClipPlaying() { return silence ? silence.isPlaying() : null; },
    // Used by Restart sound: some devices keep a stuck output on the clip's element.
    restartSilentClip() { silence?.restart(); },
    setMetadata({ title = '', artist = '', album = '', artwork = [] } = {}) {
      if (!MediaMetadataClass) return;
      try { mediaSession.metadata = new MediaMetadataClass({ title, artist, album, artwork }); } catch { /* ignore bad artwork */ }
    },

    // Call on every state change and with each stats update.
    update(state, { position, duration } = {}) {
      const active = state === 'playing' || state === 'buffering';
      if (state !== lastState) {
        lastState = state;
        mediaSession.playbackState = active ? 'playing' : state === 'paused' ? 'paused' : 'none';
        // Keep the silent clip going while paused. If the page's only media element
        // stops, some browsers (the Tesla's among them) drop the page's media
        // session. The side effect is that the car still thinks we are playing and
        // sends Pause for every press, which the pause handler above turns into Play.
        if (active || state === 'paused') silence?.play(); else silence?.pause();
        lastPositionAt = -Infinity;
      }
      // The browser advances the position itself between updates.
      if (isLive || !mediaSession.setPositionState || now() - lastPositionAt < POSITION_INTERVAL_MS) return;
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
      lastPositionAt = now();
      try {
        // playbackState already tells the browser when the position stands still.
        mediaSession.setPositionState({ duration, position: Math.min(Math.max(position, 0), duration), playbackRate: 1 });
      } catch { /* ignore */ }
    },

    dispose() {
      silence?.dispose();
      for (const action of Object.keys(handlers)) {
        try { mediaSession.setActionHandler(action, null); } catch { /* ignore */ }
      }
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
    },
  };
}
