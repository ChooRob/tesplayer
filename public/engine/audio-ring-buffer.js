const READ_INDEX = 0;
const WRITE_INDEX = 1;
const AVAILABLE_FRAMES = 2;
const RUNNING = 3;
const CONSUMED_FRAMES = 4;
const UNDERRUN_COUNT = 5;
const NEEDS_BUFFERING = 6;
const ENDED = 7;
const PROCESSING = 8;
const HEADER_LENGTH = 9;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AudioRingBuffer {
  constructor({ capacityFrames, channels }) {
    this.capacityFrames = capacityFrames;
    this.channels = channels;
    this.headerBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * HEADER_LENGTH);
    this.audioBuffer = new SharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * capacityFrames * channels,
    );
    this.header = new Int32Array(this.headerBuffer);
    this.audio = new Float32Array(this.audioBuffer);
  }

  get processorOptions() {
    return {
      headerBuffer: this.headerBuffer,
      audioBuffer: this.audioBuffer,
      capacityFrames: this.capacityFrames,
      channels: this.channels,
    };
  }

  get availableFrames() {
    return Atomics.load(this.header, AVAILABLE_FRAMES);
  }

  get consumedFrames() {
    return Atomics.load(this.header, CONSUMED_FRAMES) >>> 0;
  }

  get underrunCount() {
    return Atomics.load(this.header, UNDERRUN_COUNT) >>> 0;
  }

  get needsBuffering() {
    return Atomics.load(this.header, NEEDS_BUFFERING) === 1;
  }

  setRunning(running) {
    Atomics.store(this.header, RUNNING, running ? 1 : 0);
    if (running) Atomics.store(this.header, NEEDS_BUFFERING, 0);
  }

  markEnded() {
    Atomics.store(this.header, ENDED, 1);
  }

  async reset(shouldContinue = () => true) {
    this.setRunning(false);
    while (Atomics.load(this.header, PROCESSING)) {
      if (!shouldContinue()) return;
      await wait(1);
    }
    if (!shouldContinue()) return;
    Atomics.store(this.header, READ_INDEX, 0);
    Atomics.store(this.header, WRITE_INDEX, 0);
    Atomics.store(this.header, AVAILABLE_FRAMES, 0);
    Atomics.store(this.header, CONSUMED_FRAMES, 0);
    Atomics.store(this.header, NEEDS_BUFFERING, 0);
    Atomics.store(this.header, ENDED, 0);
  }

  async writeAudioSample(sample, { startFrame = 0, shouldContinue = () => true } = {}) {
    if (sample.numberOfChannels !== this.channels) throw new Error('Audio channel count changed during playback');
    let sourceOffset = Math.max(0, startFrame);
    while (sourceOffset < sample.numberOfFrames) {
      if (!shouldContinue()) return false;
      const writeIndex = Atomics.load(this.header, WRITE_INDEX);
      const frameCount = Math.min(sample.numberOfFrames - sourceOffset,
        this.capacityFrames - this.availableFrames, this.capacityFrames - writeIndex);
      if (frameCount === 0) { await wait(10); continue; }
      const destination = new Float32Array(this.audioBuffer,
        writeIndex * this.channels * Float32Array.BYTES_PER_ELEMENT, frameCount * this.channels);
      sample.copyTo(destination, { planeIndex: 0, format: 'f32', frameOffset: sourceOffset, frameCount });
      Atomics.store(this.header, WRITE_INDEX, (writeIndex + frameCount) % this.capacityFrames);
      Atomics.add(this.header, AVAILABLE_FRAMES, frameCount);
      sourceOffset += frameCount;
    }
    return true;
  }

  async writeSilence(frameCount, shouldContinue) {
    while (frameCount > 0) {
      if (!shouldContinue()) return false;
      const writeIndex = Atomics.load(this.header, WRITE_INDEX);
      const count = Math.min(frameCount, this.capacityFrames - this.availableFrames, this.capacityFrames - writeIndex);
      if (count === 0) {
        await wait(10);
        continue;
      }
      this.audio.fill(0, writeIndex * this.channels, (writeIndex + count) * this.channels);
      Atomics.store(this.header, WRITE_INDEX, (writeIndex + count) % this.capacityFrames);
      Atomics.add(this.header, AVAILABLE_FRAMES, count);
      frameCount -= count;
    }
    return true;
  }

}
