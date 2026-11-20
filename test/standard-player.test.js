import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { StandardPlayer, prefersNativeHls } from '../public/engine/standard-player.js';

test('built-in HLS is used on Safari, but Chromium uses hls.js', () => {
  const hls = { canPlayType: () => 'maybe' };
  const ua = userAgent => ({ navigator: { userAgent } });
  assert.equal(prefersNativeHls(hls, ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1')), true);
  assert.equal(prefersNativeHls(hls, ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15')), true);
  const originalMS = globalThis.MediaSource;
  globalThis.MediaSource = class {};
  try {
    assert.equal(prefersNativeHls(hls, ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36')), false);
    assert.equal(prefersNativeHls(hls, ua('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36')), false, 'Tesla');
    assert.equal(prefersNativeHls(hls, { navigator: { userAgent: '', userAgentData: { brands: [{ brand: 'Chromium' }] } } }), false);
  } finally { globalThis.MediaSource = originalMS; }
  assert.equal(prefersNativeHls({ canPlayType: () => '' }, ua('Safari')), false, 'no built-in HLS at all');
});

class Video extends EventTarget {
  currentTime = 0;
  duration = 20;
  paused = true;
  canPlayType() { return ''; }
  removeAttribute() {}
  load() {}
  pause() { this.paused = true; }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
}

test('native HLS loading, seeking, autoplay prompt, and disposal', async () => {
  const video = new Video();
  video.canPlayType = () => 'probably';
  Object.defineProperty(video, 'src', { set() { queueMicrotask(() => video.dispatchEvent(new Event('loadedmetadata'))); } });
  let lastDetail;
  const player = new StandardPlayer({ video, onStateChange: (_state, detail) => { lastDetail = detail; } });
  try {
    await player.load('/api/start');
    assert.equal(player.state, 'paused');
    await player.seek(12); assert.equal(player.clock.currentTime, 12);
    await player.play(); assert.equal(player.state, 'playing');
    video.play = async () => { throw new DOMException('Tap to play', 'NotAllowedError'); };
    await player.play(); assert.equal(lastDetail.audioResumeBlocked, true);
  } finally { player.destroy(); }
  assert.equal(player.liveAbort.signal.aborted, true);
});

test('fragmented MP4 uses actual codec configuration and cancels the stream on disposal', async t => {
  const result = spawnSync('ffmpeg', [
    '-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t','1','-c:v','libx264','-preset','ultrafast','-g','5','-c:a','aac',
    '-movflags','+frag_keyframe+delay_moov+default_base_moof','-f','mp4','pipe:1',
  ]);
  if (result.error?.code === 'ENOENT') { t.skip('FFmpeg is not installed'); return; }
  assert.equal(result.status, 0, result.stderr.toString());
  const video = new Video();
  let mime, appended = 0, cancelled = false;
  class Buffer extends EventTarget {
    buffered = { length: 0, start: () => 0, end: () => 1 };
    appendBuffer(bytes) {
      appended += bytes.length;
      this.buffered.length = 1;
      queueMicrotask(() => { this.dispatchEvent(new Event('updateend')); video.dispatchEvent(new Event('loadedmetadata')); });
    }
  }
  class Source extends EventTarget {
    static isTypeSupported(value) { return value.includes('avc1') && value.includes('mp4a.40.2'); }
    addSourceBuffer(value) { mime = value; return new Buffer(); }
  }
  const originalMS = globalThis.MediaSource;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  globalThis.MediaSource = Source;
  URL.createObjectURL = source => { queueMicrotask(() => source.dispatchEvent(new Event('sourceopen'))); return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  const player = new StandardPlayer({ video });
  try {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(result.stdout)); }, cancel() { cancelled = true; } });
    await player.loadLiveMpegTs('/test', { response: new Response(stream) });
    assert.match(mime, /avc1\./); assert.match(mime, /mp4a\.40\.2/);
    assert.equal(appended, result.stdout.length);
    assert.equal(player.duration, Infinity);
    player.destroy();
    await Promise.resolve();
    assert.equal(cancelled, true);
  } finally {
    player.destroy(); globalThis.MediaSource = originalMS;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});


test('VOD loading falls back once on direct failure and propagates proxy failures', async () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const start = html.indexOf('        try {\n          await player.load(startUrl');
  const end = html.indexOf('        seekBar.max', start);
  assert.ok(start > 0 && end > start);
  const source = `(async () => { ${html.slice(start, end)} })()`;
  for (const mode of ['success', 'direct-fails', 'both-fail', 'forced-proxy']) {
    const urls = [];
    const context = {
      startUrl: '/api/start?key=123', readAheadSeconds: 60, readAheadParallelism: undefined, startTime: 0, directAttempt: mode !== 'forced-proxy', vodLoading: true,
      showBanner() {}, rejectBlockedPlayback: async () => false,
      selection: { mode: 'standard' }, document: { getElementById: () => ({}) },
      player: { async load(url) {
        urls.push(url);
        if (mode === 'both-fail' || (mode === 'direct-fails' && urls.length === 1)) throw new Error('unreachable');
      } },
    };
    const result = vm.runInNewContext(source, context);
    if (mode === 'both-fail') await assert.rejects(result, /unreachable/);
    else { await result; assert.equal(context.vodLoading, false); }
    assert.deepEqual(urls, mode === 'forced-proxy' ? ['/api/start?key=123']
      : mode === 'success' ? ['/api/start?key=123&direct=1']
      : ['/api/start?key=123&direct=1', '/api/start?key=123']);
  }
});

test('Canvas playback never checks or attempts direct Plex delivery', async () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const start = html.indexOf("      directAttempt = selection.mode === 'standard'");
  const end = html.indexOf('      const dialog =', start);
  assert.ok(start > 0 && end > start);
  let fetches = 0;
  const context = {
    selection: { mode: 'canvas', error: '' }, isLive: false,
    urlParams: new URLSearchParams(), directAttempt: false,
    directCapablePromise: Promise.resolve(false),
    fetch() { fetches++; throw new Error('Canvas must not check direct capability'); },
  };
  vm.runInNewContext(html.slice(start, end), context);
  assert.equal(context.directAttempt, false);
  assert.equal(await context.directCapablePromise, false);
  assert.equal(fetches, 0);
});
