import { Input, BufferSource, ALL_FORMATS } from '../vendor/mediabunny.mjs';
import { mp4InitEnd, joinBytes } from './mp4-init.js';
import { HLS_LOAD_POLICIES } from './media-retry.js';

const MediaSourceClass = () => globalThis.MediaSource || globalThis.ManagedMediaSource;

function eventPromise(target, event, signal, timeoutMs = 20000, operation) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Browser could not play this media. Try Canvas in playback settings.')); };
    const aborted = () => { cleanup(); reject(new DOMException('Playback cancelled', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Playback timed out')); }, timeoutMs);
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    if (operation) {
      try { operation(); } catch (err) { cleanup(); reject(err); }
    }
  });
}

async function updateBuffer(buffer, operation, signal) {
  await eventPromise(buffer, 'updateend', signal, 20000, operation);
}

// Safari's built-in HLS is the best player on Apple devices (AirPlay, lock
// screen). Chromium's newer built-in HLS stalls on Plex and Jellyfin streams,
// so Chromium browsers (desktop Chrome, Edge, Tesla) use hls.js instead.
export function prefersNativeHls(video, env = globalThis) {
  if (!video.canPlayType('application/vnd.apple.mpegurl')) return false;
  const brands = env.navigator?.userAgentData?.brands || [];
  const chromium = brands.some(({ brand }) => /Chromium/.test(brand))
    || /\b(Chrome|Chromium|Edg)\//.test(env.navigator?.userAgent || '');
  return !chromium || !MediaSourceClass();
}

export class StandardPlayer {
  static supports({ video, live = false }) {
    if (live) return !!MediaSourceClass();
    return !!video.canPlayType('application/vnd.apple.mpegurl')
      || !!MediaSourceClass()?.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
  }

  constructor({ video, onStateChange = () => {}, onStats = () => {}, onMediaWait = () => {} }) {
    this.video = video;
    this.onStateChange = onStateChange;
    this.onMediaWait = onMediaWait;
    this.state = 'idle';
    this.clock = { get currentTime() { return video.currentTime; } };
    this.listeners = [];
    for (const [event, state] of [['playing', 'playing'], ['pause', 'paused'], ['waiting', 'buffering'], ['ended', 'ended']]) {
      const listener = () => { if (!this.resetting) this.setState(state); };
      video.addEventListener(event, listener);
      this.listeners.push([event, listener]);
    }
    const error = () => { if (!this.resetting) this.fail(new Error(video.error?.message || 'Browser video playback failed')); };
    video.addEventListener('error', error);
    this.listeners.push(['error', error]);
    this.statsTimer = setInterval(() => onStats({ state: this.state, mediaTime: video.currentTime }), 250);
  }
  get duration() { return this.isLive ? Infinity : (this.video.duration || 0); }
  setState(state, detail = {}) { this.state = state; this.onStateChange(state, detail); }
  fail(error) { this.setState('error', { error }); }
  reset() {
    this.resetting = true;
    this.liveAbort?.abort();
    this.hls?.destroy(); this.hls = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.liveAbort = new AbortController();
    this.resetting = false;
  }
  async load(url) {
    this.reset(); this.isLive = false; this.setState('loading');
    const signal = this.liveAbort.signal;
    const ready = eventPromise(this.video, 'loadedmetadata', signal);
    ready.catch(() => {});
    if (prefersNativeHls(this.video)) {
      this.video.src = url;
    } else {
      let Hls;
      try {
        ({ default: Hls } = await import('/vendor/hls.mjs'));
        if (!Hls.isSupported()) throw new Error('Standard HLS playback is unavailable. Try Canvas in playback settings.');
      } catch (err) {
        this.liveAbort.abort();
        await ready.catch(() => {});
        throw err;
      }
      this.hls = new Hls({ backBufferLength: 30, maxBufferLength: 20, ...HLS_LOAD_POLICIES });
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          this.fail(new Error(`Stream failed: ${data.details}`));
          this.liveAbort.abort();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.onMediaWait({ status: data.response?.code ?? 0 });
        }
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
    }
    await ready;
    this.setState('paused');
  }
  async loadLiveMpegTs(url, { response, abortController } = {}) {
    this.reset(); this.isLive = true; this.setState('loading');
    if (abortController) { this.liveAbort.abort(); this.liveAbort = abortController; }
    const signal = this.liveAbort.signal;
    try {
      response ||= await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error(`Live stream failed (${response.status})`);
      const reader = response.body.getReader();
      signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
      let initial = new Uint8Array();
      let end;
      while (!(end = mp4InitEnd(initial))) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Live stream ended before it was ready');
        initial = joinBytes(initial, value);
        if (initial.length > 8 * 1024 * 1024) throw new Error('Live stream initialization is too large');
      }
      // Inspect only the init segment. Decoding and presentation stay in <video>.
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(initial.subarray(0, end)) });
      const codecs = [];
      try {
        for (const track of await input.getTracks()) {
          if (track.type === 'video' || track.type === 'audio') codecs.push((await track.getDecoderConfig()).codec);
        }
      } finally { input.dispose(); }
      const mime = `video/mp4; codecs="${codecs.join(',')}"`;
      const MSC = MediaSourceClass();
      if (!MSC?.isTypeSupported(mime)) throw new Error('Standard playback cannot decode this stream. Try Canvas in settings.');
      const source = new MSC();
      const opened = eventPromise(source, 'sourceopen', signal);
      this.video.disableRemotePlayback = true;
      this.objectUrl = URL.createObjectURL(source);
      this.video.src = this.objectUrl;
      await opened;
      const buffer = source.addSourceBuffer(mime);
      const ready = eventPromise(this.video, 'loadedmetadata', signal);
      ready.catch(() => {});
      const pump = async () => {
        let bytes = initial;
        for (;;) {
          if (signal.aborted) return;
          // Bound decoded media retention and stop pulling when playback is paused.
          while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - this.video.currentTime > 20) {
            await new Promise(resolve => setTimeout(resolve, 200));
            if (signal.aborted) return;
          }
          const removeUntil = this.video.currentTime - 15;
          if (removeUntil > 0 && buffer.buffered.length && buffer.buffered.start(0) < removeUntil) {
            await updateBuffer(buffer, () => buffer.remove(0, removeUntil), signal);
          }
          await updateBuffer(buffer, () => buffer.appendBuffer(bytes), signal);
          if (!this.startedAtLive && buffer.buffered.length) {
            this.startedAtLive = true;
            this.video.currentTime = buffer.buffered.start(0);
          }
          const result = await reader.read();
          if (result.done) throw new Error('Live stream ended');
          bytes = result.value;
        }
      };
      this.startedAtLive = false;
      void pump().catch(err => { if (!signal.aborted) { this.fail(err); this.liveAbort.abort(); } });
      await ready;
      this.setState('paused');
    } catch (err) { this.liveAbort.abort(); throw err; }
  }
  async play() {
    try { await this.video.play(); }
    catch (err) {
      if (err.name === 'NotAllowedError') this.onStateChange(this.state, { audioResumeBlocked: true });
      else if (err.name !== 'AbortError') this.fail(err);
    }
  }
  pause() { this.video.pause(); }
  // The browser's video volume tops out at 1, so there is no boost here.
  setVolume(multiplier) { this.video.volume = Math.min(1, Math.max(0, Number.isFinite(multiplier) ? multiplier : 1)); }
  async seek(time) { this.video.currentTime = Math.max(0, Math.min(time, this.duration)); }
  destroy() {
    clearInterval(this.statsTimer);
    for (const [event, listener] of this.listeners) this.video.removeEventListener(event, listener);
    this.reset();
    this.liveAbort.abort();
  }
}
