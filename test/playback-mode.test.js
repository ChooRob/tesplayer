import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePlaybackMode, canvasSupport, readPlaybackMode, isHandheld } from '../public/engine/playback-mode.js';
import { mp4InitEnd, joinBytes } from '../public/engine/mp4-init.js';
const supported = { standardSupported: true, canvasError: '' };
test('missing and legacy Auto preferences use Canvas without automatic fallback', () => {
  for (const preference of [undefined, 'auto', 'invalid']) {
    assert.deepEqual(choosePlaybackMode(preference, supported), { mode: 'canvas', error: '' });
    assert.deepEqual(choosePlaybackMode(preference, { ...supported, canvasError: 'No WebCodecs' }),
      { mode: 'canvas', error: 'No WebCodecs' });
  }
});
test('explicit preferences win and unsupported choices return errors', () => {
  assert.equal(choosePlaybackMode('standard', supported).mode, 'standard');
  assert.equal(choosePlaybackMode('canvas', supported).mode, 'canvas');
  assert.equal(choosePlaybackMode('canvas', { ...supported, canvasError: 'HTTPS required' }).error, 'HTTPS required');
  assert.ok(choosePlaybackMode('standard', { standardSupported: false }).error);
});
test('over plain HTTP Canvas is turned off and Standard is used instead', () => {
  const insecure = { ...supported, canvasError: 'Canvas playback requires HTTPS or localhost.', secure: false };
  for (const preference of [undefined, 'canvas', 'standard']) {
    assert.deepEqual(choosePlaybackMode(preference, insecure), { mode: 'standard', error: '' });
  }
  assert.ok(choosePlaybackMode('canvas', { ...insecure, standardSupported: false }).error, 'no player at all is still an error');
});
test('blocked, missing, invalid, and legacy Auto storage defaults to Canvas', () => {
  assert.equal(readPlaybackMode({ getItem() { throw Error(); } }), 'canvas');
  assert.equal(readPlaybackMode(undefined), 'canvas');
  for (const stored of [null, 'invalid', 'auto', 'canvas']) {
    assert.equal(readPlaybackMode({ getItem() { return stored; } }), 'canvas');
  }
  assert.equal(readPlaybackMode({ getItem() { return 'standard'; } }), 'standard');
});
test('phones and tablets default to Standard; a saved choice still wins', () => {
  assert.equal(readPlaybackMode({ getItem() { return null; } }, { handheld: true }), 'standard');
  assert.equal(readPlaybackMode({ getItem() { throw Error(); } }, { handheld: true }), 'standard');
  assert.equal(readPlaybackMode({ getItem() { return 'canvas'; } }, { handheld: true }), 'canvas');
  const ua = userAgent => ({ navigator: { userAgent, maxTouchPoints: 0 } });
  assert.equal(isHandheld(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1')), true);
  assert.equal(isHandheld(ua('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/148 Mobile Safari/537.36')), true);
  assert.equal(isHandheld({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 } }), true);
  // Tesla's browser identifies as desktop Linux and must keep Canvas.
  assert.equal(isHandheld(ua('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36')), false);
  assert.equal(isHandheld(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0.0.0 Safari/537.36')), false);
});
test('Canvas checks security, decoding and audio APIs', () => {
  assert.match(canvasSupport({}), /HTTPS/);
  assert.match(canvasSupport({ isSecureContext: true }), /isolation/);
  const env = { isSecureContext: true, crossOriginIsolated: true, SharedArrayBuffer: class {}, VideoDecoder: class {}, AudioDecoder: class {}, AudioWorkletNode: class {}, AudioContext: class {} };
  assert.equal(canvasSupport(env), '');
  delete env.AudioDecoder; assert.match(canvasSupport(env), /decoders/);
});
const box = type => Uint8Array.from([0,0,0,8, ...Array.from(type, c=>c.charCodeAt(0))]);
test('MP4 initialization handles arbitrary network chunk boundaries', () => {
  const bytes=joinBytes(box('ftyp'), box('moov'));
  for(let i=0;i<bytes.length;i++) assert.equal(mp4InitEnd(bytes.subarray(0,i)),null);
  assert.equal(mp4InitEnd(joinBytes(bytes, box('moof'))),16);
  assert.throws(()=>mp4InitEnd(new Uint8Array(8)), /Invalid/);
});
