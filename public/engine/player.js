// Adapted from drive-in’s mediabunny engine; see THIRD-PARTY-NOTICES.md.
// Bounded decode queues feed an audio-clocked render loop and shared audio buffer.

import { AudioSampleSink, VideoSampleSink, Input, ALL_FORMATS, UrlSource, ReadableStreamSource } from '../vendor/mediabunny.mjs';
import { decodedFrameCapacity, normalizeQuality } from './quality-tiers.js';
import { AudioRingBuffer } from './audio-ring-buffer.js';
import { PresentationClock, estimateAudioOutputLatencySeconds } from './presentation-clock.js';
import { SegmentPrefetcher } from './segment-prefetch.js';
import { createRetryingFetch } from './media-retry.js';

// Buffer compressed media in the source; retain only a handful of decoded
// frames so hardware decoder surfaces and browser memory stay bounded.
// Plex HLS segments can span several seconds. Leave room for the next segment
// so the audio producer can request it before the ring is nearly empty.
const AUDIO_CAPACITY_SECONDS = 16;
// Some HLS starts expose less than six seconds before video consumption begins.
const AUDIO_START_SECONDS = 2;
// A read that fails this close to the end of a stream, after everything before it
// was decoded, is the end of the stream (a cut-off final packet), not a failure.
const STREAM_END_TOLERANCE_SECONDS = 5;
const AUDIO_REBUFFER_SECONDS = 1;
// After running dry mid-playback, rebuild a real cushion before resuming.
// Resuming at the 2-second startup mark on a slow link flickers between
// playing and buffering every second or two.
const AUDIO_RESUME_SECONDS = 6;
const VIDEO_START_SECONDS = 0.15;
const VIDEO_REBUFFER_SECONDS = 0.03;

const ITERATOR_CLOSE_TIMEOUT_MS = 1500;
// How long a finished track's audio waits for the next track to finish opening, before ending as usual.
const PREPARE_WAIT_MS = 4000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function closeIterator(iterator) {
  if (typeof iterator?.return !== 'function') return true;
  let timeout = null;
  const closed = Promise.resolve().then(() => iterator.return()).then(() => true, () => false);
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), ITERATOR_CLOSE_TIMEOUT_MS);
  });
  const result = await Promise.race([closed, timedOut]);
  clearTimeout(timeout);
  return result;
}

export class Player {
  constructor({ canvas, quality = 'high', onStateChange = () => {}, onStats = () => {}, onTrackChange = () => {}, onMediaWait = () => {} }) {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
      throw new Error('Player requires COOP/COEP (crossOriginIsolated) and SharedArrayBuffer');
    }

    this.quality = normalizeQuality(quality);
    this.volume = 1; // multiplier; above 1 boosts through a limiter
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.onStateChange = onStateChange;
    this.onStats = onStats;
    this.onTrackChange = onTrackChange;
    // Gapless music: the next track, opened ahead (prepared), then with its audio queued behind this one's (chained).
    this.prepared = null;
    this.preparing = null;
    this.chained = null;
    this.onMediaWait = onMediaWait;

    this.input = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoSink = null;
    this.audioSink = null;

    this.audioContext = null;
    this.audioRing = null;
    this.audioNode = null;
    this.clock = new PresentationClock();

    this.state = 'idle';
    this.wantsPlayback = false;
    this.generation = 0;
    this.destroyed = false;

    this.videoQueue = [];
    this.videoQueueCapacity = decodedFrameCapacity(this.quality, this.canvas.width || 1280, this.canvas.height || 720);
    this.videoEnded = false;
    this.audioEnded = false;
    this.firstVideoRendered = false;
    this.rebuffering = false;
    this.lastRenderedTimestamp = 0;

    this.videoDecodeCount = 0;
    this.videoRenderCount = 0;
    this.videoDropCount = 0;
    this.audioPacketCount = 0;
    this.audioDecodeWaitMs = 0;
    this.audioWriteWaitMs = 0;
    this.lastStatsAt = 0;

    this.duration = 0;
    this.videoIterator = null;
    this.audioIterator = null;
    this.seeking = false;
    this.restartingAudio = false;
    // Counters for the dev-only audio diagnostics (see audioDiagnostics()).
    this.audioStateChanges = 0;
    this.audioResumeTimeouts = 0;
    this.audioResumeMs = null;
    this.audioRestarts = 0;

    this.renderFrame = this.renderFrame.bind(this);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  clearVideoQueue() {
    for (const frame of this.videoQueue) frame.close();
    this.videoQueue.length = 0;
  }

  async destroy() {
    this.destroyed = true;
    ++this.generation;
    cancelAnimationFrame(this.animationFrame);
    this.liveAbort?.abort();
    this.clearVideoQueue();
    this.discardNext();
    this.disposePreviousInputs();
    this.audioNode?.disconnect();
    await Promise.allSettled([closeIterator(this.videoIterator), closeIterator(this.audioIterator), this.audioContext?.close()]);
  }

  // Dispose the previous input before reconnecting to release scarce hardware decoders.
  disposePreviousInputs() {
    this.clearVideoQueue();
    this.prefetcher?.dispose();
    this.prefetcher = null;
    this.input?.dispose?.();
    this.input = null;
    this.videoInput?.dispose?.();
    this.videoInput = null;
    this.audioInput?.dispose?.();
    this.audioInput = null;
  }

  async load(url, { direct = false, readAheadSeconds = 0, readAheadParallelism = 2, startTime = 0 } = {}) {
    this.setState('loading');
    ++this.generation;
    // Loading over a track that is already playing (music moving on without a page reload): silence it first.
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.discardNext();
    this.disposePreviousInputs();
    const sourceOptions = { maxCacheSize: this.quality === 'ultra' ? 24 * 1024 * 1024 : 8 * 1024 * 1024 };
    // Through the relay, a media server that is slow to answer is waited for (see media-retry.js).
    const relayFetch = createRetryingFetch({ onWaiting: (detail) => this.onMediaWait(detail) });
    if (readAheadSeconds > 0 && !direct) {
      this.prefetcher = new SegmentPrefetcher({ readAheadSeconds, parallelism: readAheadParallelism, fetchFn: relayFetch });
      sourceOptions.fetchFn = this.prefetcher.fetch;
    } else if (!direct) {
      sourceOptions.fetchFn = relayFetch;
    }
    this.input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, direct ? {
      ...sourceOptions,
      fetchFn: (resource, init = {}) => fetch(resource, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      }),
      getRetryDelay: () => null,
    } : sourceOptions) });

    this.videoTrack = await this.input.getPrimaryVideoTrack();
    this.audioTrack = await this.input.getPrimaryAudioTrack();
    if (!this.videoTrack && !this.audioTrack) throw new Error('No playable audio or video track');

    if (this.videoTrack) {
      const width = await this.videoTrack.getDisplayWidth();
      const height = await this.videoTrack.getDisplayHeight();
      this.canvas.width = width;
      this.canvas.height = height;
      this.videoQueueCapacity = decodedFrameCapacity(this.quality, width, height);
      this.videoSink = new VideoSampleSink(this.videoTrack, { optimizeForLatency: true });
    }

    if (this.audioTrack) {
      const sampleRate = await this.audioTrack.getSampleRate();
      const channels = await this.audioTrack.getNumberOfChannels();
      // The same output carries on when the new track fits it; otherwise (or the first time) it is built.
      const reusable = this.audioContext && this.audioContext.state !== 'closed' && this.audioRing
        && this.audioContext.sampleRate === sampleRate && this.audioRing.channels === channels;
      if (!reusable) {
        this.audioNode?.disconnect();
        this.audioNode = null;
        const oldContext = this.audioContext;
        this.audioContext = null;
        await oldContext?.close().catch(() => {});
        await this.initializeAudio({ sampleRate, channels });
      }
      this.audioSink = new AudioSampleSink(this.audioTrack);
    }

    const tracks = [this.videoTrack, this.audioTrack].filter(Boolean);
    const durations = await Promise.all(tracks.map(async (track) => (
      await track.getDurationFromMetadata() ?? await track.computeDuration()
    )));
    this.duration = Math.max(0, ...durations);

    // Start decoding at the resume point directly, so a slow connection
    // doesn't first download the opening segment only to seek away from it.
    this.prefetcher?.activate();
    await this.restartProducers(clamp(Number(startTime) || 0, 0, this.duration || Infinity));
    this.setState('paused');
  }

  // Reuse an inspected response to avoid opening a second relay stream.
  async loadLiveMpegTs(url, { response: preFetched, abortController } = {}) {
    this.setState('loading');
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    ++this.generation;
    this.liveAbort?.abort();
    this.disposePreviousInputs();
    this.audioNode?.disconnect();
    if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close();
    this.videoSink = null;
    this.audioSink = null;
    let response = preFetched;
    if (!response) {
      this.liveAbort = new AbortController();
      response = await fetch(url, { signal: this.liveAbort.signal });
    } else {
      this.liveAbort = abortController || null;
    }
    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `Failed to fetch live stream: ${response.status}`);
    }

    this.isLive = true;
    this.disposePreviousInputs();
    this.input = new Input({ formats: ALL_FORMATS, source: new ReadableStreamSource(response.body, { maxCacheSize: this.quality === 'ultra' ? 24 * 1024 * 1024 : 8 * 1024 * 1024 }) });

    this.videoTrack = await this.input.getPrimaryVideoTrack();
    this.audioTrack = await this.input.getPrimaryAudioTrack();
    if (!this.videoTrack && !this.audioTrack) throw new Error('No playable audio or video track');

    if (this.videoTrack) {
      const width = await this.videoTrack.getDisplayWidth();
      const height = await this.videoTrack.getDisplayHeight();
      this.canvas.width = width;
      this.canvas.height = height;
      this.videoQueueCapacity = decodedFrameCapacity(this.quality, width, height);
      this.videoSink = new VideoSampleSink(this.videoTrack, { optimizeForLatency: true });
    }

    if (this.audioTrack) {
      await this.initializeAudio({
        sampleRate: await this.audioTrack.getSampleRate(),
        channels: await this.audioTrack.getNumberOfChannels(),
      });
      this.audioSink = new AudioSampleSink(this.audioTrack);
    }

    this.duration = Infinity;
    const startTime = await this.input.getFirstTimestamp();
    await this.restartProducers(startTime);
    this.setState('paused');
  }

  // Gapless music: open the next track while this one plays, so its first audio is ready when this one ends.
  // Throws (and leaves nothing behind) if it cannot be played straight after this one, so the caller can
  // simply load it when the time comes.
  prepareNext(url, options) {
    const opening = this.openNext(url, options);
    const tracked = opening.then(() => {}, () => {});
    this.preparing = tracked;
    tracked.then(() => { if (this.preparing === tracked) this.preparing = null; });
    return opening;
  }

  async openNext(url, { readAheadSeconds = 0, readAheadParallelism = 2 } = {}) {
    if (this.isLive || !this.audioTrack || !this.audioRing || !this.audioContext || this.destroyed) throw new Error('Cannot prepare a next track');
    this.discardNext();
    const generation = this.generation;
    const prepared = { input: null, prefetcher: null, track: null, sink: null, iterator: null, first: null, duration: 0 };
    this.prepared = prepared;
    const abandoned = () => this.prepared !== prepared || generation !== this.generation || this.destroyed;
    try {
      const sourceOptions = { maxCacheSize: this.quality === 'ultra' ? 24 * 1024 * 1024 : 8 * 1024 * 1024 };
      if (readAheadSeconds > 0) {
        prepared.prefetcher = new SegmentPrefetcher({ readAheadSeconds, parallelism: readAheadParallelism });
        sourceOptions.fetchFn = prepared.prefetcher.fetch;
      }
      prepared.input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, sourceOptions) });
      prepared.track = await prepared.input.getPrimaryAudioTrack();
      if (abandoned()) throw new Error('Next track no longer wanted');
      if (!prepared.track) throw new Error('No audio in the next track');
      // The output runs at one rate and channel count; a track that differs cannot follow on without a gap.
      if (await prepared.track.getSampleRate() !== this.audioContext.sampleRate
        || await prepared.track.getNumberOfChannels() !== this.audioRing.channels) throw new Error('Next track needs a different audio output');
      prepared.duration = (await prepared.track.getDurationFromMetadata() ?? await prepared.track.computeDuration()) || 0;
      if (abandoned()) throw new Error('Next track no longer wanted');
      prepared.sink = new AudioSampleSink(prepared.track);
      // Start reading it now: the first segments, and the read-ahead behind them, come while this track plays.
      prepared.prefetcher?.activate();
      prepared.iterator = prepared.sink.samples(0);
      prepared.first = await prepared.iterator.next();
      if (abandoned()) throw new Error('Next track no longer wanted');
      return { duration: prepared.duration };
    } catch (error) {
      if (this.prepared === prepared) this.prepared = null;
      this.disposeNextParts(prepared);
      throw error;
    }
  }

  disposeNextParts(next) {
    if (!next) return;
    const first = next.first?.value;
    try { first?.close?.(); } catch { /* already closed */ }
    void closeIterator(next.iterator);
    next.prefetcher?.dispose();
    next.input?.dispose?.();
  }

  // The next track is not wanted (the queue changed, a new track): let go of it, opened ahead or queued.
  discardNext() {
    const next = this.prepared;
    this.prepared = null;
    this.disposeNextParts(next);
    this.discardChained();
  }

  discardChained() {
    const chained = this.chained;
    this.chained = null;
    this.clock.clearChain();
    this.disposeNextParts(chained);
  }

  // Playback has crossed from one track into the one queued behind it.
  commitChained() {
    const next = this.chained;
    if (!next) return;
    this.chained = null;
    this.prefetcher?.dispose();
    this.input?.dispose?.();
    this.input = next.input;
    this.prefetcher = next.prefetcher;
    this.audioTrack = next.track;
    this.audioSink = next.sink;
    this.duration = next.duration;
    this.onTrackChange({ duration: next.duration });
  }

  // Play the track opened ahead (prepareNext) right now, from its start, rather than waiting for this one to end:
  // the skip button's version of the gapless handoff. Resolves false when there is nothing ready to play.
  async adoptPrepared() {
    const next = this.prepared;
    if (!next || !next.iterator || this.chained || this.isLive || this.destroyed) return false;
    this.prepared = null;
    try { next.first?.value?.close?.(); } catch { /* already closed */ }
    next.first = null;
    void closeIterator(next.iterator);
    const oldInput = this.input;
    const oldPrefetcher = this.prefetcher;
    this.input = next.input;
    this.prefetcher = next.prefetcher;
    this.audioTrack = next.track;
    this.audioSink = next.sink;
    this.duration = next.duration;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.seeking = true;
    this.setState('buffering', { reason: 'seek' });
    const restart = this.restartProducers(0);
    const generation = this.generation;
    await restart;
    oldPrefetcher?.dispose();
    oldInput?.dispose?.();
    if (generation !== this.generation || this.destroyed) return true;
    this.seeking = false;
    if (this.wantsPlayback) this.updatePlaybackBarrier();
    else this.setState('paused');
    return true;
  }

  async restartProducers(mediaTime) {
    const generation = ++this.generation;
    // A seek or reload makes a track already queued behind this one stale; one only opened ahead is still good.
    this.discardChained();

    const oldVideoIterator = this.videoIterator;
    const oldAudioIterator = this.audioIterator;
    this.videoIterator = null;
    this.audioIterator = null;
    this.clearVideoQueue();
    await Promise.all([closeIterator(oldVideoIterator), closeIterator(oldAudioIterator)]);
    if (generation !== this.generation || this.destroyed) return;
    await this.audioRing?.reset(() => generation === this.generation && !this.destroyed);
    if (generation !== this.generation || this.destroyed) return;

    this.videoQueueCapacity = decodedFrameCapacity(this.quality, this.canvas.width || 1280, this.canvas.height || 720);
    this.videoEnded = !this.videoTrack;
    this.audioEnded = !this.audioTrack;
    this.firstVideoRendered = false;
    this.rebuffering = false;
    this.lastRenderedTimestamp = mediaTime;
    if (this.audioTrack && this.audioRing && this.audioContext) {
      this.clock.useAudioRing(this.audioRing, this.audioContext.sampleRate);
    }
    this.clock.reset(mediaTime);

    if (this.videoSink) {
      this.videoIterator = this.videoSink.samples(mediaTime);
      void this.produceVideo(generation, this.videoIterator);
    }
    if (this.audioSink) {
      this.audioIterator = this.audioSink.samples(mediaTime);
      void this.produceAudio(generation, mediaTime, this.audioIterator);
    }
  }

  async seek(seconds) {
    if (this.isLive || !this.input || this.destroyed) return;
    const target = clamp(Number(seconds) || 0, 0, this.duration || Infinity);
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.seeking = true;
    this.setState('buffering', { reason: 'seek' });
    const restart = this.restartProducers(target);
    const generation = this.generation;
    await restart;
    if (generation !== this.generation || this.destroyed) return;
    this.seeking = false;
    if (this.wantsPlayback) this.updatePlaybackBarrier();
    else this.setState('paused');
  }

  // Rebuild the audio output at the current position, without reloading the
  // page: when the device never produced sound, a fresh AudioContext usually
  // gets a working output. Movies only; a live stream has nothing to seek back
  // to, so the caller reconnects it instead. Resolves false when nothing was done.
  async restartAudio() {
    if (this.isLive || !this.audioTrack || !this.input || this.destroyed || this.restartingAudio) return false;
    this.restartingAudio = true;
    this.audioRestarts += 1;
    try {
      const mediaTime = this.clock.currentTime;
      const oldContext = this.audioContext;
      this.audioRing?.setRunning(false);
      this.clock.stop();
      this.seeking = true;
      ++this.generation; // stops the producers writing into the old ring
      this.setState('buffering', { reason: 'audio-restart' });
      this.audioNode?.disconnect();
      this.audioNode = null;
      this.audioContext = null;
      await oldContext?.close().catch(() => {});
      if (this.destroyed) return false;
      await this.initializeAudio({
        sampleRate: await this.audioTrack.getSampleRate(),
        channels: await this.audioTrack.getNumberOfChannels(),
      });
      // Start the new context before playback restarts, so the ring isn't
      // started against a suspended output.
      const resumed = !this.wantsPlayback || await this.resumeAudioContext();
      // seek() restarts both producers at mediaTime and resumes or pauses as before.
      this.seeking = false;
      await this.seek(mediaTime);
      if (!resumed) this.onStateChange(this.state, { audioResumeBlocked: true });
      return true;
    } finally {
      this.seeking = false;
      this.restartingAudio = false;
    }
  }

  // False when the context couldn't start in time, e.g. blocked by autoplay policy.
  async resumeAudioContext(timeoutMs = 1500) {
    if (!this.audioContext || this.audioContext.state === 'running' || this.audioContext.state === 'closed') return true;
    const timedOut = Symbol('timeout');
    const startedAt = performance.now();
    const result = await Promise.race([
      this.audioContext.resume(),
      new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
    ]);
    if (result === timedOut) { this.audioResumeTimeouts += 1; return false; }
    this.audioResumeMs = Math.round(performance.now() - startedAt);
    return true;
  }

  async initializeAudio({ sampleRate, channels }) {
    if (typeof AudioWorkletNode !== 'function') throw new Error('Player requires AudioWorklet');

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate });
    this.audioContext.addEventListener('statechange', () => { this.audioStateChanges += 1; });
    if (this.audioContext.sampleRate !== sampleRate) {
      throw new Error(`Sample-rate conversion not supported (${sampleRate} -> ${this.audioContext.sampleRate})`);
    }

    await this.audioContext.audioWorklet.addModule('/engine/audio-worklet-processor.js');

    this.audioRing = new AudioRingBuffer({
      capacityFrames: Math.ceil(this.audioContext.sampleRate * AUDIO_CAPACITY_SECONDS),
      channels,
    });
    this.audioNode = new AudioWorkletNode(this.audioContext, 'drivein-audio-output-v1', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: this.audioRing.processorOptions,
    });
    this.audioNode.port.onmessage = (event) => {
      if (event.data?.type === 'underrun' && this.wantsPlayback && !this.audioEnded) {
        this.enterBuffering('audio-underrun');
      }
    };
    // Volume sits between the decoder's output and the speakers. Above 1 the
    // signal also passes a limiter, so a boost squashes peaks instead of clipping.
    this.gainNode = this.audioContext.createGain();
    this.limiter = this.audioContext.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.limiterOn = null; // not yet routed
    this.audioNode.connect(this.gainNode);
    this.applyVolume();
    this.clock.useAudioRing(this.audioRing, this.audioContext.sampleRate);
  }

  // 1 is the original level, 0 is silent, up to 2 is a boost. Applies at once and
  // survives the audio context being rebuilt.
  setVolume(multiplier) {
    this.volume = Math.min(4, Math.max(0, Number.isFinite(multiplier) ? multiplier : 1));
    this.applyVolume();
  }

  applyVolume() {
    if (!this.gainNode) return;
    this.gainNode.gain.value = this.volume;
    const boosted = this.volume > 1;
    if (boosted === this.limiterOn) return;
    this.limiterOn = boosted;
    this.gainNode.disconnect();
    this.limiter.disconnect();
    if (boosted) {
      this.gainNode.connect(this.limiter);
      this.limiter.connect(this.audioContext.destination);
    } else {
      this.gainNode.connect(this.audioContext.destination);
    }
  }

  atStreamEnd(decodedUntil) {
    return !this.isLive && Number.isFinite(this.duration) && this.duration > 0
      && decodedUntil > 0 && this.duration - decodedUntil <= STREAM_END_TOLERANCE_SECONDS;
  }

  async produceVideo(generation, iterator) {
    let decodedUntil = 0;
    try {
      while (generation === this.generation && !this.destroyed) {
        while (this.videoQueue.length >= this.videoQueueCapacity) {
          if (generation !== this.generation || this.destroyed) return;
          await wait(10);
        }
        const result = await iterator.next();
        if (generation !== this.generation || this.destroyed) { result.value?.close(); return; }
        if (result.done) {
          this.videoEnded = true;
          return;
        }
        this.videoQueue.push(result.value);
        this.videoDecodeCount += 1;
        decodedUntil = result.value.timestamp + (result.value.duration || 0);
      }
    } catch (err) {
      if (generation !== this.generation || this.destroyed) return;
      if (this.atStreamEnd(decodedUntil)) this.videoEnded = true;
      else this.fail(err);
    }
  }

  async produceAudio(generation, mediaTime, iterator) {
    let nextFrame = 0;
    let decodedUntil = 0;
    // Where the track being read starts: its time origin, and the output frame it begins at. A second track
    // (gapless music) continues from the frame where the first ended.
    let trackOrigin = mediaTime;
    let frameBase = 0;
    let pending = null;
    const shouldContinue = () => generation === this.generation && !this.destroyed;
    try {
      while (generation === this.generation && !this.destroyed) {
        const decodeStartedAt = performance.now();
        const result = pending ?? await iterator.next();
        pending = null;
        this.audioDecodeWaitMs += performance.now() - decodeStartedAt;
        if (generation !== this.generation || this.destroyed) { result.value?.close(); return; }
        if (result.done) {
          // Gapless: the next track, if one is ready (or about to be), carries straight on in the same output.
          if (!this.prepared && this.preparing) await Promise.race([this.preparing, wait(PREPARE_WAIT_MS)]);
          if (generation !== this.generation || this.destroyed) return;
          const next = this.prepared;
          if (next && !this.chained && !this.isLive) {
            this.prepared = null;
            this.chained = next;
            iterator = next.iterator;
            this.audioIterator = iterator;
            pending = next.first;
            next.first = null;
            trackOrigin = 0;
            frameBase = nextFrame;
            this.clock.chainAt(nextFrame);
            continue;
          }
          this.audioEnded = true;
          this.audioRing.markEnded();
          return;
        }
        const sample = result.value;
        this.audioPacketCount += 1;
        try {
          // Keep the ring on the media timeline across seeks and HLS segments.
          const packetFrame = frameBase + Math.round((sample.timestamp - trackOrigin) * sample.sampleRate);
          const endFrame = packetFrame + sample.numberOfFrames;
          if (endFrame <= nextFrame) continue;
          const writeStartedAt = performance.now();
          if (packetFrame > nextFrame && !(await this.audioRing.writeSilence(packetFrame - nextFrame, shouldContinue))) return;
          const wrote = await this.audioRing.writeAudioSample(sample, {
            startFrame: Math.max(0, nextFrame - packetFrame), shouldContinue,
          });
          if (!wrote) return;
          this.audioWriteWaitMs += performance.now() - writeStartedAt;
          nextFrame = endFrame;
          decodedUntil = sample.timestamp + sample.numberOfFrames / sample.sampleRate;
        } finally { sample.close(); }
      }
    } catch (err) {
      if (generation !== this.generation || this.destroyed) return;
      if (this.atStreamEnd(decodedUntil)) {
        this.audioEnded = true;
        this.audioRing.markEnded();
      } else this.fail(err);
    }
  }

  async play() {
    this.wantsPlayback = true;
    // Time out autoplay-blocked resume calls so playback can show a recovery prompt.
    if (!(await this.resumeAudioContext())) {
      this.onStateChange(this.state, { audioResumeBlocked: true });
      return;
    }
    // Pressing play after the end starts again from the beginning.
    if (this.state === 'ended') { await this.seek(0); return; }
    this.updatePlaybackBarrier();
  }

  // A movie or episode is over once both tracks have been read to the end and
  // everything decoded has been shown and heard. The page moves on from here.
  finishIfPlayedOut() {
    if (this.isLive || this.seeking || this.state !== 'playing') return;
    if (!this.videoEnded || !this.audioEnded || this.videoQueue.length) return;
    if (this.audioRing && this.audioRing.availableFrames > 0) return;
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState('ended');
  }

  pause() {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState('paused');
  }

  renderFrame(now) {
    if (this.destroyed) return;
    this.animationFrame = requestAnimationFrame(this.renderFrame);

    if (this.isLive && this.wantsPlayback && this.videoEnded && this.audioEnded
      && this.videoQueue.length === 0 && (!this.audioRing || this.audioRing.availableFrames === 0)) {
      this.fail(new Error('Live stream ended'));
    }

    if (!this.seeking && this.audioEnded && this.audioRing?.availableFrames === 0) {
      this.clock.useWallClock();
    }
    if (this.chained && this.clock.takeCrossing()) this.commitChained();
    const mediaTime = this.clock.currentTime;
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    this.renderVideo(videoPresentationTime);
    this.updatePlaybackBarrier();
    this.finishIfPlayedOut();

    if (now - this.lastStatsAt < 250) return;
    this.lastStatsAt = now;
    this.onStats({
      state: this.state,
      mediaTime,
      videoTime: this.lastRenderedTimestamp,
      videoPresentationTime,
      videoQueueLength: this.videoQueue.length,
      videoDecodeCount: this.videoDecodeCount,
      videoRenderCount: this.videoRenderCount,
      videoDropCount: this.videoDropCount,
      audioAvailableSeconds: this.audioSeconds,
      audioContextState: this.audioContext?.state || 'none',
      audioUnderrunCount: this.audioRing?.underrunCount || 0,
      audioConsumedFrames: this.audioRing?.consumedFrames || 0,
      audioPacketCount: this.audioPacketCount,
      audioDecodeWaitMs: this.audioDecodeWaitMs,
      audioWriteWaitMs: this.audioWriteWaitMs,
      ...this.audioDiagnostics(),
    });
  }

  renderVideo(mediaTime) {
    if (!this.videoTrack || !this.videoQueue.length) return;
    let selected = null;
    while (this.videoQueue.length && this.videoQueue[0].timestamp <= mediaTime + 0.001) {
      if (selected) { selected.close(); this.videoDropCount += 1; }
      selected = this.videoQueue.shift();
    }
    const preview = !selected && !this.firstVideoRendered && !this.wantsPlayback;
    if (preview) selected = this.videoQueue[0];
    if (!selected) return;

    selected.draw(this.context, 0, 0, this.canvas.width, this.canvas.height);
    this.lastRenderedTimestamp = selected.timestamp;
    this.videoRenderCount += 1;
    this.firstVideoRendered = true;
    if (!preview) selected.close();
  }

  updatePlaybackBarrier() {
    if (this.seeking || !this.wantsPlayback || this.destroyed || this.state === 'ended' || this.state === 'error') return;
    const mediaTime = this.clock.currentTime;
    if (this.state === 'playing') {
      if (!this.hasPlaybackSafetyMargin(mediaTime)) this.enterBuffering('queue-low');
      return;
    }
    if (this.hasStartupBuffer(mediaTime)) {
      this.enterPlaying();
    } else {
      this.enterBuffering('waiting-for-both-tracks');
    }
  }

  hasStartupBuffer(mediaTime) {
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    const videoAhead = this.videoSecondsAhead(videoPresentationTime);
    // Live streams can't build far ahead of the edge, so keep their resume threshold low.
    const audioTarget = this.rebuffering && !this.isLive
      ? Math.min(AUDIO_RESUME_SECONDS, AUDIO_CAPACITY_SECONDS / 2) : AUDIO_START_SECONDS;
    const audioReady = !this.audioTrack || this.audioSeconds >= audioTarget || this.audioEnded;
    const videoReady = !this.videoTrack
      || videoAhead >= VIDEO_START_SECONDS
      || (this.videoQueue.length >= this.videoQueueCapacity && videoAhead > 0)
      || this.videoEnded;
    return audioReady && videoReady;
  }

  hasPlaybackSafetyMargin(mediaTime) {
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    const videoAhead = this.videoSecondsAhead(videoPresentationTime);
    const audioSafe = !this.audioTrack || this.audioSeconds >= AUDIO_REBUFFER_SECONDS || this.audioEnded;
    const videoSafe = !this.videoTrack
      || videoAhead >= VIDEO_REBUFFER_SECONDS
      || (this.videoQueue.length >= Math.min(2, this.videoQueueCapacity) && videoAhead > 0)
      || this.videoEnded;
    const unexpectedAudioUnderrun = this.audioRing?.needsBuffering && !this.audioEnded;
    return audioSafe && videoSafe && !unexpectedAudioUnderrun;
  }

  enterPlaying() {
    if (this.state === 'playing') return;
    this.rebuffering = false;
    this.clock.start();
    this.audioRing?.setRunning(true);
    this.setState('playing');
  }

  enterBuffering(reason) {
    if (this.state === 'buffering') return;
    if (this.state === 'playing') this.rebuffering = true;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState('buffering', { reason });
  }

  videoSecondsAhead(mediaTime) {
    const last = this.videoQueue[this.videoQueue.length - 1];
    if (!last) return 0;
    return Math.max(0, last.timestamp + last.duration - mediaTime);
  }

  getVideoPresentationTime(mediaTime) {
    return Math.max(0, mediaTime - estimateAudioOutputLatencySeconds(this.audioContext));
  }

  get audioSeconds() {
    if (!this.audioRing || !this.audioContext) return 0;
    return this.audioRing.availableFrames / this.audioContext.sampleRate;
  }

  // What the audio output is doing, for working out why a start was silent.
  // The server only keeps these outside production.
  audioDiagnostics() {
    const context = this.audioContext;
    const out = {
      audioStateChanges: this.audioStateChanges,
      audioResumeTimeouts: this.audioResumeTimeouts,
      audioRestarts: this.audioRestarts,
    };
    if (!context) return out;
    const number = (key, value) => { if (Number.isFinite(value) && value >= 0) out[key] = value; };
    number('audioSampleRate', context.sampleRate);
    number('audioBaseLatency', context.baseLatency);
    number('audioOutputLatency', context.outputLatency);
    number('audioResumeMs', this.audioResumeMs);
    number('audioGain', this.gainNode?.gain.value);
    number('audioLimiterOn', this.limiterOn ? 1 : 0);
    try {
      const stamp = context.getOutputTimestamp?.();
      number('audioOutputContextTime', stamp?.contextTime);
      number('audioOutputPerfTime', stamp?.performanceTime);
    } catch { /* Older Chromium builds can expose the method without a usable timestamp. */ }
    if (typeof context.sinkId === 'string') out.audioSinkId = context.sinkId;
    else if (typeof context.sinkId?.type === 'string') out.audioSinkId = `type:${context.sinkId.type}`;
    return out;
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange(state, detail);
  }

  fail(err) {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState('error', { error: err });
  }
}
