const MAX_AUDIO_OUTPUT_LATENCY_SECONDS = 0.5;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function estimateAudioOutputLatencySeconds(audioContext, now = performance.now()) {
  if (!audioContext) return 0;

  // currentTime advances in render quanta and is not a reliable measure
  // of output latency, especially around seek and buffering transitions.
  const outputLatency = audioContext.outputLatency;
  if (Number.isFinite(outputLatency) && outputLatency >= 0) {
    return Math.min(MAX_AUDIO_OUTPUT_LATENCY_SECONDS,
      finiteNonNegative(audioContext.baseLatency) + outputLatency);
  }

  try {
    const timestamp = audioContext.getOutputTimestamp?.();
    const contextTime = Number(timestamp?.contextTime);
    const performanceTime = Number(timestamp?.performanceTime);
    const currentTime = Number(audioContext.currentTime);
    if (
      Number.isFinite(contextTime)
      && Number.isFinite(performanceTime)
      && performanceTime > 0 && performanceTime <= now
      && Number.isFinite(currentTime)
    ) {
      const elapsed = Math.max(0, now - performanceTime) / 1000;
      const audibleContextTime = contextTime + elapsed;
      return Math.min(
        MAX_AUDIO_OUTPUT_LATENCY_SECONDS,
        Math.max(0, currentTime - audibleContextTime),
      );
    }
  } catch {
    // Older Chromium builds can expose the method without a usable timestamp.
  }

  return Math.min(
    MAX_AUDIO_OUTPUT_LATENCY_SECONDS,
    finiteNonNegative(audioContext.baseLatency),
  );
}

export class PresentationClock {
  constructor() {
    this.audioRing = null;
    this.sampleRate = 0;
    this.baseMediaTime = 0;
    this.wallStartedAt = 0;
    this.wallElapsed = 0;
    this.running = false;
    // Gapless music: the output frame where the next track begins, once its audio has been queued behind this one's.
    this.chainFrame = null;
    this.crossed = false;
  }

  // Time starts again from 0 at this frame of the output, which is where the next track's audio begins.
  chainAt(frame) {
    this.chainFrame = Number.isFinite(frame) && frame >= 0 ? frame : null;
    this.crossed = false;
  }

  clearChain() {
    this.chainFrame = null;
    this.crossed = false;
  }

  // True once, when playback has crossed into the next track.
  takeCrossing() {
    this.applyChain();
    const crossed = this.crossed;
    this.crossed = false;
    return crossed;
  }

  applyChain() {
    if (this.chainFrame === null || !this.audioRing || this.sampleRate <= 0) return;
    if (this.audioRing.consumedFrames < this.chainFrame) return;
    this.baseMediaTime = -this.chainFrame / this.sampleRate;
    this.chainFrame = null;
    this.crossed = true;
  }

  useAudioRing(audioRing, sampleRate) {
    this.audioRing = audioRing;
    this.sampleRate = sampleRate;
  }

  useWallClock() {
    if (!this.audioRing) return;
    const mediaTime = this.currentTime;
    this.audioRing = null;
    this.sampleRate = 0;
    this.reset(mediaTime);
  }

  reset(mediaTime) {
    this.clearChain();
    this.baseMediaTime = mediaTime;
    this.wallElapsed = 0;
    this.wallStartedAt = performance.now();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.wallStartedAt = performance.now();
  }

  stop() {
    if (!this.running) return;
    if (!this.audioRing) {
      this.wallElapsed += (performance.now() - this.wallStartedAt) / 1000;
    }
    this.running = false;
  }

  get currentTime() {
    this.applyChain();
    if (this.audioRing && this.sampleRate > 0) {
      return this.baseMediaTime + this.audioRing.consumedFrames / this.sampleRate;
    }

    const activeElapsed = this.running
      ? (performance.now() - this.wallStartedAt) / 1000
      : 0;
    return this.baseMediaTime + this.wallElapsed + activeElapsed;
  }
}
