const READ_INDEX = 0;
const AVAILABLE_FRAMES = 2;
const RUNNING = 3;
const CONSUMED_FRAMES = 4;
const UNDERRUN_COUNT = 5;
const NEEDS_BUFFERING = 6;
const ENDED = 7;
const PROCESSING = 8;

class DriveInAudioOutputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions;
    this.header = new Int32Array(config.headerBuffer);
    this.audio = new Float32Array(config.audioBuffer);
    this.capacityFrames = config.capacityFrames;
    this.channels = config.channels;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frameCount = output[0]?.length || 0;

    for (const channel of output) channel.fill(0);
    if (!frameCount || Atomics.load(this.header, RUNNING) !== 1) return true;

    // A seek waits for the current render quantum before clearing the ring.
    Atomics.store(this.header, PROCESSING, 1);
    try {
      if (Atomics.load(this.header, RUNNING) === 1) this.readFrames(output, frameCount);
    } finally {
      Atomics.store(this.header, PROCESSING, 0);
    }
    return true;
  }

  readFrames(output, frameCount) {
    const available = Atomics.load(this.header, AVAILABLE_FRAMES);
    if (available < frameCount && Atomics.load(this.header, ENDED) !== 1) {
      if (Atomics.compareExchange(this.header, NEEDS_BUFFERING, 0, 1) === 0) {
        Atomics.add(this.header, UNDERRUN_COUNT, 1);
        this.port.postMessage({ type: "underrun", availableFrames: available });
      }
      return;
    }

    const consumed = Math.min(available, frameCount);
    let readIndex = Atomics.load(this.header, READ_INDEX);
    let outputFrame = 0;
    while (outputFrame < consumed) {
      const contiguous = Math.min(consumed - outputFrame, this.capacityFrames - readIndex);
      for (let frame = 0; frame < contiguous; frame++) {
        const sourceOffset = (readIndex + frame) * this.channels;
        for (let channel = 0; channel < output.length; channel++) {
          output[channel][outputFrame + frame] = this.audio[sourceOffset + Math.min(channel, this.channels - 1)];
        }
      }
      outputFrame += contiguous;
      readIndex += contiguous;
      if (readIndex === this.capacityFrames) readIndex = 0;
    }

    Atomics.store(this.header, READ_INDEX, readIndex);
    Atomics.sub(this.header, AVAILABLE_FRAMES, consumed);
    Atomics.add(this.header, CONSUMED_FRAMES, consumed);
  }
}

registerProcessor("drivein-audio-output-v1", DriveInAudioOutputProcessor);
