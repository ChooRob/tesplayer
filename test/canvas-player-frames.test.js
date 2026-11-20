import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {Player} from '../public/engine/player.js';
import { AudioRingBuffer } from '../public/engine/audio-ring-buffer.js';
import { AudioSample } from '../public/vendor/mediabunny.mjs';
import { estimateAudioOutputLatencySeconds, PresentationClock } from '../public/engine/presentation-clock.js';
function frame(timestamp){return {timestamp,duration:1/30,draws:0,closed:0,draw(){this.draws++;},close(){this.closed++;}};}
function player(frames){const p=Object.create(Player.prototype);Object.assign(p,{videoTrack:{},videoQueue:frames,canvas:{width:1280,height:720},context:{},videoDropCount:0,videoRenderCount:0,firstVideoRendered:false});return p;}
test('renders directly from the sample and releases displayed and skipped frames',()=>{
 const a=frame(0),b=frame(.03),c=frame(.06),p=player([a,b,c]);p.renderVideo(.04);
 assert.equal(a.closed,1);assert.equal(b.draws,1);assert.equal(b.closed,1);assert.equal(c.closed,0);assert.equal(p.videoDropCount,1);
 p.clearVideoQueue();assert.equal(c.closed,1);assert.equal(p.videoQueue.length,0);
});
test('previewing a future sample keeps it alive until its presentation time',()=>{
 const a=frame(1),p=player([a]);p.renderVideo(0);assert.equal(a.draws,1);assert.equal(a.closed,0);assert.equal(p.videoQueue.length,1);
 p.renderVideo(1);assert.equal(a.closed,1);assert.equal(p.videoQueue.length,0);
});

test('active playback never previews a frame ahead of the audio clock', () => {
  const next = frame(31);
  const p = player([next]);
  p.wantsPlayback = true;
  p.renderVideo(30);
  assert.equal(next.draws, 0);
  assert.equal(next.closed, 0);
  p.renderVideo(31);
  assert.equal(next.draws, 1);
  assert.equal(next.closed, 1);
});
test('a late sample from a cancelled generation is closed immediately',async()=>{
 const a=frame(0),p=player([]);Object.assign(p,{generation:1,destroyed:false,videoQueueCapacity:6});
 await p.produceVideo(1,{async next(){p.generation=2;return {value:a,done:false};}});assert.equal(a.closed,1);assert.equal(p.videoQueue.length,0);
});

test('audio after a seek fills timeline gaps and trims overlapping packets', async () => {
  const p = player([]);
  const ring = new AudioRingBuffer({ capacityFrames: 20, channels: 1 });
  Object.assign(p, { generation: 1, destroyed: false, audioRing: ring });
  const packet = (timestamp, samples) => ({
    timestamp, sampleRate: 10, numberOfFrames: samples.length, numberOfChannels: 1,
    copyTo(destination, { frameOffset, frameCount }) {
      destination.set(samples.slice(frameOffset, frameOffset + frameCount));
    },
    close() {},
  });
  async function* audio() {
    yield packet(9.9, [7]);
    yield packet(10.2, [1, 2, 3]);
    yield packet(10.4, [8, 4]);
    yield packet(10.8, [5]);
  }
  await p.produceAudio(1, 10, audio());
  assert.equal(ring.availableFrames, 9);
  assert.deepEqual([...ring.audio.slice(0, 9)], [0, 0, 1, 2, 3, 4, 0, 0, 5]);
  assert.equal(p.audioEnded, true);
});

test('an older seek cannot resume playback while a newer seek is pending', async () => {
  const p = player([]);
  const complete = [];
  let resumed = 0;
  Object.assign(p, {
    input: {}, duration: 120, generation: 0, wantsPlayback: true,
    clock: { stop() {} }, onStateChange() {},
    restartProducers() {
      ++this.generation;
      return new Promise(resolve => complete.push(resolve));
    },
    updatePlaybackBarrier() { resumed++; },
  });
  const first = p.seek(20);
  const second = p.seek(40);
  complete[0]();
  await first;
  assert.equal(p.seeking, true);
  assert.equal(resumed, 0);
  complete[1]();
  await second;
  assert.equal(p.seeking, false);
  assert.equal(resumed, 1);
});

test('reported audio latency takes precedence over an unreliable rendering clock', () => {
  const context = {
    baseLatency: 0.01, outputLatency: 0.125, currentTime: 5,
    getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 2000 }),
  };
  assert.equal(estimateAudioOutputLatencySeconds(context, 2010), 0.135);
  assert.equal(estimateAudioOutputLatencySeconds({ ...context, outputLatency: undefined,
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, 2010), 0.01);
});

test('queued video behind the seek clock cannot start or keep audio playing', () => {
  const p = player([frame(9.8), frame(9.85)]);
  p.videoQueueCapacity = 2;
  p.videoEnded = false;
  assert.equal(p.hasStartupBuffer(10), false);
  assert.equal(p.hasPlaybackSafetyMargin(10), false);
  p.videoQueue = [frame(9.98), frame(10)];
  assert.equal(p.hasStartupBuffer(10), true);
  assert.equal(p.hasPlaybackSafetyMargin(10), true);
});

test('Canvas waits for a useful audio cushion before starting or resuming', () => {
  const p = player([frame(0), frame(0.1), frame(0.2)]);
  p.videoQueueCapacity = 3;
  p.audioTrack = {};
  p.audioEnded = false;
  p.videoEnded = false;
  p.audioContext = { sampleRate: 10, baseLatency: 0, outputLatency: 0 };
  p.audioRing = { availableFrames: 19, needsBuffering: false };
  assert.equal(p.hasStartupBuffer(0), false);
  p.audioRing.availableFrames = 20;
  assert.equal(p.hasStartupBuffer(0), true);
  p.audioRing.availableFrames = 9;
  assert.equal(p.hasPlaybackSafetyMargin(0), false);
  p.audioRing.availableFrames = 10;
  assert.equal(p.hasPlaybackSafetyMargin(0), true);
});

test('after running dry mid-playback, Canvas rebuilds a bigger cushion before resuming', () => {
  const p = player([frame(0), frame(0.1), frame(0.2)]);
  Object.assign(p, {
    videoQueueCapacity: 3, audioTrack: {}, audioEnded: false, videoEnded: false,
    audioContext: { sampleRate: 10, baseLatency: 0, outputLatency: 0 },
    audioRing: { availableFrames: 20, needsBuffering: false, setRunning() {} },
    clock: { start() {}, stop() {} }, onStateChange() {}, state: 'playing',
  });
  p.enterBuffering('queue-low');
  assert.equal(p.hasStartupBuffer(0), false, '2 seconds is not enough after a stall');
  p.audioRing.availableFrames = 60;
  assert.equal(p.hasStartupBuffer(0), true);
  p.enterPlaying();
  p.state = 'paused';
  p.audioRing.availableFrames = 20;
  assert.equal(p.hasStartupBuffer(0), true, 'a normal pause resumes at the startup threshold');
  p.isLive = true;
  p.state = 'playing';
  p.enterBuffering('queue-low');
  assert.equal(p.hasStartupBuffer(0), true, 'live keeps the low threshold');
});

test('audio ring preserves stereo samples across wraparound', async () => {
  let Processor;
  const source = readFileSync(new URL('../public/engine/audio-worklet-processor.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    AudioWorkletProcessor: class { port = { postMessage() {} }; },
    registerProcessor(_name, registered) { Processor = registered; },
    Int32Array, Float32Array, Atomics,
  });
  const ring = new AudioRingBuffer({ capacityFrames: 4, channels: 2 });
  const processor = new Processor({ processorOptions: ring.processorOptions });
  ring.setRunning(true);
  const audio = (values, timestamp) => new AudioSample({
    format: 'f32', sampleRate: 10, numberOfChannels: 2, timestamp,
    data: new Float32Array(values),
  });
  const firstSample = audio([1, 11, 2, 12, 3, 13], 0);
  await ring.writeAudioSample(firstSample);
  firstSample.close();
  const first = [new Float32Array(2), new Float32Array(2)];
  processor.process([], [first]);
  assert.deepEqual([...first[0]], [1, 2]);
  assert.deepEqual([...first[1]], [11, 12]);
  const secondSample = audio([4, 14, 5, 15, 6, 16], 0.3);
  await ring.writeAudioSample(secondSample);
  secondSample.close();
  const second = [new Float32Array(4), new Float32Array(4)];
  processor.process([], [second]);
  assert.deepEqual([...second[0]], [3, 4, 5, 6]);
  assert.deepEqual([...second[1]], [13, 14, 15, 16]);
  const planar = new AudioSample({ format: 'f32-planar', sampleRate: 10,
    numberOfChannels: 2, timestamp: 0.6, data: new Float32Array([7, 8, 17, 18]) });
  await ring.writeAudioSample(planar);
  planar.close();
  const third = [new Float32Array(2), new Float32Array(2)];
  processor.process([], [third]);
  assert.deepEqual([...third[0]], [7, 8]);
  assert.deepEqual([...third[1]], [17, 18]);
});

test('restartAudio replaces the AudioContext and seeks back to the same position', async () => {
  const p = player([]);
  const closed = [];
  const oldContext = { close: async () => { closed.push('old'); } };
  const events = [];
  Object.assign(p, {
    isLive: false, input: {}, destroyed: false, generation: 4, seeking: false, restartingAudio: false,
    state: 'playing', wantsPlayback: true, onStateChange: (state) => events.push(state),
    audioContext: oldContext, audioNode: { disconnect() { events.push('disconnect'); } },
    audioRing: { setRunning(on) { events.push(`ring:${on}`); } },
    clock: { currentTime: 42.5, stop() { events.push('clock-stop'); } },
    audioTrack: { getSampleRate: async () => 48000, getNumberOfChannels: async () => 2 },
  });
  p.initializeAudio = async (options) => {
    assert.deepEqual(options, { sampleRate: 48000, channels: 2 });
    assert.equal(p.seeking, true, 'frames must not present while the output is rebuilt');
    p.audioContext = { state: 'running', close: async () => {} };
  };
  let seekedTo = null;
  p.seek = async (time) => { seekedTo = time; };
  assert.equal(await p.restartAudio(), true);
  assert.deepEqual(closed, ['old']);
  assert.equal(seekedTo, 42.5);
  assert.equal(p.generation, 5);
  assert.equal(p.seeking, false);
  assert.equal(p.restartingAudio, false);
  assert.notEqual(p.audioContext, oldContext);
});

test('restartAudio does nothing for live streams, silent files and overlapping calls', async () => {
  for (const patch of [{ isLive: true }, { audioTrack: null }, { restartingAudio: true }]) {
    const p = player([]);
    Object.assign(p, { isLive: false, input: {}, destroyed: false, restartingAudio: false, audioTrack: {}, ...patch });
    assert.equal(await p.restartAudio(), false);
  }
});

test('volume above 1 routes through the limiter, and back to 1 bypasses it', () => {
  const links = [];
  const node = name => ({ name, disconnect() { for (let i = links.length - 1; i >= 0; i--) if (links[i][0] === name) links.splice(i, 1); }, connect(to) { links.push([name, to.name ?? to]); } });
  const p = Object.create(Player.prototype);
  p.audioContext = { destination: { name: 'speakers' } };
  p.gainNode = Object.assign(node('gain'), { gain: { value: 1 } });
  p.limiter = node('limiter');
  p.limiterOn = null;
  p.volume = 1;
  p.applyVolume();
  assert.deepEqual(links, [['gain', 'speakers']]);
  p.setVolume(1.6);
  assert.equal(p.gainNode.gain.value, 1.6);
  assert.deepEqual(links, [['gain', 'limiter'], ['limiter', 'speakers']]);
  p.setVolume(1.2);
  assert.deepEqual(links, [['gain', 'limiter'], ['limiter', 'speakers']], 'staying boosted does not rewire');
  p.setVolume(0.5);
  assert.deepEqual(links, [['gain', 'speakers']]);
  p.setVolume(9);
  assert.equal(p.volume, 4, 'the boost is capped at 4');
  p.setVolume(NaN);
  assert.equal(p.volume, 1);
});

function endingPlayer(duration) {
  const p = player([]);
  const failures = [];
  const ring = new AudioRingBuffer({ capacityFrames: 100, channels: 1 });
  Object.assign(p, {
    generation: 1, destroyed: false, isLive: false, duration, audioRing: ring, videoQueueCapacity: 6,
    videoEnded: false, audioEnded: false, fail(error) { failures.push(error); },
  });
  return { p, failures };
}
const audioPacket = (timestamp, frames = 10) => ({
  timestamp, sampleRate: 10, numberOfFrames: frames, numberOfChannels: 1,
  copyTo(destination) { destination.fill(1); }, close() {},
});

test('audio that fails to read right at the end of the stream ends it instead of failing', async () => {
  const { p, failures } = endingPlayer(20);
  async function* audio() { yield audioPacket(17); yield audioPacket(18); yield audioPacket(19); throw new Error('cut-off final packet'); }
  await p.produceAudio(1, 17, audio());
  assert.equal(p.audioEnded, true);
  assert.equal(failures.length, 0);
});

test('audio that fails to read in the middle of the stream still fails', async () => {
  const { p, failures } = endingPlayer(1200);
  async function* audio() { yield audioPacket(100); throw new Error('bad packet'); }
  await p.produceAudio(1, 100, audio());
  assert.equal(p.audioEnded, false);
  assert.equal(failures.length, 1);
});

test('video that fails to read right at the end of the stream ends it instead of failing', async () => {
  const { p, failures } = endingPlayer(20);
  const frames = [frame(18), frame(19), { ...frame(19.5), duration: 0.5 }];
  let at = 0;
  await p.produceVideo(1, { async next() { if (at < frames.length) return { value: frames[at++], done: false }; throw new Error('cut-off final frame'); } });
  assert.equal(p.videoEnded, true);
  assert.equal(failures.length, 0);
});

test('a live stream never treats a read failure as the end', async () => {
  const { p, failures } = endingPlayer(Infinity);
  p.isLive = true;
  async function* audio() { yield audioPacket(5); throw new Error('dropped'); }
  await p.produceAudio(1, 5, audio());
  assert.equal(failures.length, 1);
});

test('nothing decoded yet means a read failure is a real failure', async () => {
  const { p, failures } = endingPlayer(3);
  async function* audio() { throw new Error('unreadable'); }
  await p.produceAudio(1, 0, audio());
  assert.equal(failures.length, 1);
});

function playedOutPlayer(overrides = {}) {
  const states = [];
  const p = player([]);
  Object.assign(p, {
    isLive: false, seeking: false, state: 'playing', wantsPlayback: true,
    videoEnded: true, audioEnded: true, audioRing: { availableFrames: 0, setRunning() {} },
    clock: { stop() { states.push('clock-stopped'); } },
    setState(state) { this.state = state; states.push(state); },
    ...overrides,
  });
  return { p, states };
}

test('playback ends once both tracks are read out and everything has been shown and heard', () => {
  const { p, states } = playedOutPlayer();
  p.finishIfPlayedOut();
  assert.equal(p.state, 'ended');
  assert.equal(p.wantsPlayback, false);
  assert.deepEqual(states, ['clock-stopped', 'ended']);
});

test('playback does not end while frames or audio are still waiting, or a track is still being read', () => {
  for (const overrides of [
    { videoQueue: [frame(1)] },
    { audioRing: { availableFrames: 10, setRunning() {} } },
    { videoEnded: false },
    { audioEnded: false },
    { seeking: true },
    { state: 'buffering' },
    { isLive: true },
  ]) {
    const { p } = playedOutPlayer(overrides);
    p.finishIfPlayedOut();
    assert.notEqual(p.state, 'ended', JSON.stringify(Object.keys(overrides)));
  }
});

test('a video with no sound ends when its picture has played out', () => {
  const { p } = playedOutPlayer({ audioRing: null });
  p.finishIfPlayedOut();
  assert.equal(p.state, 'ended');
});

test('pressing play after the end starts again from the beginning', async () => {
  const p = player([]);
  const seeks = [];
  Object.assign(p, {
    state: 'ended', wantsPlayback: false, resumeAudioContext: async () => true,
    seek: async seconds => { seeks.push(seconds); }, updatePlaybackBarrier() { seeks.push('barrier'); },
  });
  await p.play();
  assert.equal(p.wantsPlayback, true);
  assert.deepEqual(seeks, [0]);
});

// Gapless music: the next track's audio is queued straight behind this one's, in the same output.
function chainingPlayer() {
  const p = player([]);
  const ring = new AudioRingBuffer({ capacityFrames: 100, channels: 1 });
  const clock = new PresentationClock();
  clock.useAudioRing(ring, 10);
  clock.reset(0);
  const changes = [];
  Object.assign(p, {
    generation: 1, destroyed: false, isLive: false, duration: 2, audioRing: ring, clock, prepared: null, preparing: null, chained: null,
    audioEnded: false, onTrackChange: (info) => changes.push(info), fail(error) { throw error; },
  });
  return { p, ring, clock, changes };
}
const valued = (timestamp, value, frames = 10) => ({
  timestamp, sampleRate: 10, numberOfFrames: frames, numberOfChannels: 1,
  copyTo(destination) { destination.fill(value); }, close() {},
});
function preparedTrack(duration, packets) {
  let at = 1;
  return {
    input: { dispose() { this.disposed = true; } }, prefetcher: { dispose() { this.disposed = true; } }, track: { id: 'next' }, sink: { id: 'next' },
    duration, first: { value: packets[0], done: false },
    iterator: { async next() { return at < packets.length ? { value: packets[at++], done: false } : { value: undefined, done: true }; }, async return() {} },
  };
}
async function* firstTrack() { yield valued(0, 1); yield valued(1, 1); }

test('the next track carries straight on from the end of this one, with no gap', async () => {
  const { p, ring } = chainingPlayer();
  p.prepared = preparedTrack(2, [valued(0, 2), valued(1, 2)]);
  await p.produceAudio(1, 0, firstTrack());
  assert.equal(ring.availableFrames, 40);
  assert.deepEqual([...ring.audio.slice(0, 40)], [...Array(20).fill(1), ...Array(20).fill(2)]);
  assert.equal(p.chained.track.id, 'next');
  assert.equal(p.prepared, null);
  assert.equal(p.clock.chainFrame, 20, 'the boundary is where the first track ended');
  assert.equal(p.audioEnded, true, 'and the output ends when the last track does');
});

test('crossing into the chained track switches what the player is playing, and says so', async () => {
  const { p, ring, clock, changes } = chainingPlayer();
  const first = { input: { dispose() { this.disposed = true; } }, prefetcher: { dispose() { this.disposed = true; } } };
  Object.assign(p, { input: first.input, prefetcher: first.prefetcher });
  p.prepared = preparedTrack(180, [valued(0, 2)]);
  await p.produceAudio(1, 0, firstTrack());
  const next = p.chained;
  ring.header[4] = 15; // playing the first track still (output frame 15 of 20)
  assert.equal(clock.takeCrossing(), false);
  ring.header[4] = 23; // three frames into the next
  assert.equal(clock.takeCrossing(), true);
  p.commitChained();
  assert.equal(p.duration, 180);
  assert.equal(p.input, next.input);
  assert.equal(p.audioSink, next.sink);
  assert.equal(first.input.disposed, true, 'the finished track is let go');
  assert.equal(first.prefetcher.disposed, true);
  assert.equal(p.chained, null);
  assert.deepEqual(changes, [{ duration: 180 }]);
  assert.ok(Math.abs(clock.currentTime - 0.3) < 1e-9, 'time is now three frames into the next track');
});

test('with no next track ready, the output simply ends', async () => {
  const { p, ring } = chainingPlayer();
  await p.produceAudio(1, 0, firstTrack());
  assert.equal(ring.availableFrames, 20);
  assert.equal(p.chained, null);
  assert.equal(p.audioEnded, true);
});

test('a next track still opening is waited for briefly', async () => {
  const { p, ring } = chainingPlayer();
  p.preparing = new Promise((resolve) => setTimeout(() => { p.prepared = preparedTrack(2, [valued(0, 2)]); resolve(); }, 20));
  await p.produceAudio(1, 0, firstTrack());
  assert.equal(ring.availableFrames, 30);
  assert.equal(p.chained.track.id, 'next');
});

test('a seek drops a track already queued behind, and a new load drops one opened ahead', () => {
  const { p } = chainingPlayer();
  const queued = preparedTrack(2, [valued(0, 2)]);
  const opened = preparedTrack(2, [valued(0, 3)]);
  p.chained = queued; p.prepared = opened;
  p.clock.chainAt(20);
  p.discardChained();
  assert.equal(p.chained, null);
  assert.equal(queued.input.disposed, true);
  assert.equal(p.clock.chainFrame, null);
  assert.equal(p.prepared, opened, 'one only opened ahead is still good after a seek');
  p.discardNext();
  assert.equal(p.prepared, null);
  assert.equal(opened.input.disposed, true);
});

test('skipping to the track opened ahead plays it from its start and lets go of the old one', async () => {
  const { p } = chainingPlayer();
  const old = { input: { dispose() { this.disposed = true; } }, prefetcher: { dispose() { this.disposed = true; } } };
  const restarts = [];
  Object.assign(p, { input: old.input, prefetcher: old.prefetcher, wantsPlayback: false, setState() {}, updatePlaybackBarrier() {},
    async restartProducers(time) { restarts.push(time); } });
  const next = preparedTrack(200, [valued(0, 2)]);
  p.prepared = next;
  assert.equal(await p.adoptPrepared(), true);
  assert.deepEqual(restarts, [0]);
  assert.equal(p.input, next.input);
  assert.equal(p.audioSink, next.sink);
  assert.equal(p.duration, 200);
  assert.equal(p.prepared, null);
  assert.equal(old.input.disposed, true);
  assert.equal(old.prefetcher.disposed, true);
  assert.equal(next.input.disposed, undefined, 'the track now playing is kept');
  assert.equal(await p.adoptPrepared(), false, 'nothing left to adopt');
});
