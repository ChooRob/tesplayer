import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseSourceRate, deviceClass, gpuRenderer } from '../public/engine/device.js';

const CAR_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MCU2_GPU = 'ANGLE (Intel, Mesa Intel(R) HD Graphics 505 (APL 3), OpenGL 4.6)';

test('the MCU2 is told by its Apollo Lake graphics chip and its touchscreen, so it keeps the 48 kHz stream', () => {
  assert.equal(canUseSourceRate({ userAgent: CAR_UA, touchPoints: 16, renderer: MCU2_GPU }), false);
  assert.equal(canUseSourceRate({ userAgent: CAR_UA, touchPoints: 16, renderer: 'ANGLE (Intel, Mesa Intel(R) HD Graphics 505, OpenGL 4.6)' }), false);
});

test('the MCU3 (AMD Ryzen, about eight times faster) takes the music as it is', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  assert.equal(canUseSourceRate({ userAgent: ua, touchPoints: 16, renderer: 'ANGLE (AMD, AMD Radeon Vega 1 Graphics (radeonsi raven ACO), OpenGL 4.6)' }), true);
});

test('a car whose graphics chip is not known is treated as an MCU2', () => {
  assert.equal(canUseSourceRate({ userAgent: CAR_UA, touchPoints: 16, renderer: '' }), false);
});

test('other browsers take the music as it is', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
  assert.equal(canUseSourceRate({ userAgent: mac, touchPoints: 0, renderer: '' }), true);
  assert.equal(canUseSourceRate({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', touchPoints: 5, renderer: '' }), true);
  assert.equal(canUseSourceRate({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36', touchPoints: 5, renderer: '' }), true);
  // Linux with no touchscreen is a desktop, and Linux with a touchscreen and a different chip is not the car's.
  assert.equal(canUseSourceRate({ userAgent: CAR_UA, touchPoints: 0, renderer: MCU2_GPU }), true);
  assert.equal(canUseSourceRate({ userAgent: CAR_UA, touchPoints: 10, renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir), OpenGL 4.6)' }), true);
});

test('the graphics chip is read without breaking when the browser will not say', () => {
  assert.equal(gpuRenderer({ createElement: () => { throw new Error('no canvas'); } }), '');
  assert.equal(gpuRenderer({ createElement: () => ({ getContext: () => null }) }), '');
  const gl = { RENDERER: 1, getExtension: name => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 2 } : null), getParameter: key => (key === 2 ? MCU2_GPU : 'WebKit WebGL') };
  assert.equal(gpuRenderer({ createElement: () => ({ getContext: () => gl }) }), MCU2_GPU);
});

test('the car is told as an MCU2 or an MCU3 by its graphics chip, and unsure means MCU2', () => {
  const touch = { userAgent: CAR_UA, touchPoints: 16 };
  assert.equal(deviceClass({ ...touch, renderer: MCU2_GPU }), 'mcu2');
  assert.equal(deviceClass({ ...touch, renderer: 'ANGLE (AMD, AMD Radeon Vega 1 Graphics (radeonsi raven ACO), OpenGL 4.6)' }), 'mcu3');
  assert.equal(deviceClass({ ...touch, renderer: '' }), 'mcu2');
  assert.equal(deviceClass({ ...touch, renderer: 'ANGLE (NVIDIA, GeForce, OpenGL 4.6)' }), 'other');
  assert.equal(deviceClass({ userAgent: CAR_UA, touchPoints: 0, renderer: 'ANGLE (AMD, AMD Radeon, OpenGL 4.6)' }), 'other', 'a desktop');
  assert.equal(deviceClass({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0.0.0 Safari/537.36', touchPoints: 0, renderer: '' }), 'other');
});
