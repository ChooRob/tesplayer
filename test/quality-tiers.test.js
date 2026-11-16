import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_QUALITY_LEVELS, QUALITY_LEVELS, decodedFrameCapacity, normalizeQuality, plexProfileConstraints, qualityTiers } from '../public/engine/quality-tiers.js';

test('the ladder runs Ultra, High, Medium, Low, and Auto never picks Ultra', () => {
  assert.deepEqual(QUALITY_LEVELS, ['ultra', 'high', 'medium', 'low']);
  assert.deepEqual(AUTO_QUALITY_LEVELS, ['high', 'medium', 'low']);
});

test('an unknown tier means High', () => {
  assert.equal(normalizeQuality('ultra'), 'ultra');
  assert.equal(normalizeQuality('enhanced'), 'high');
  assert.equal(normalizeQuality(undefined), 'high');
});

test('decoded frames stay small and shrink with pixel count', () => {
  assert.equal(decodedFrameCapacity('high', 1280, 720), 6);
  assert.equal(decodedFrameCapacity('high', 1920, 1080), 3);
  assert.ok(decodedFrameCapacity('ultra', 1920, 1080) <= 8);
  assert.ok(decodedFrameCapacity('ultra', 1920, 1080) >= decodedFrameCapacity('high', 1920, 1080));
});

test('High keeps the old defaults and Ultra sits above it at 1080p', () => {
  const tiers = qualityTiers(4000);
  assert.deepEqual(tiers.high, { videoBitrate: 2000, videoResolution: '1280x720' });
  assert.deepEqual(tiers.medium, { videoBitrate: 1000, videoResolution: '960x540' });
  assert.deepEqual(tiers.low, { videoBitrate: 500, videoResolution: '640x360' });
  assert.deepEqual(tiers.ultra, { videoBitrate: 6000, videoResolution: '1920x1080' });
});

test('the configured bitrate limits High, and Ultra is never below 6 Mbit/s', () => {
  assert.equal(qualityTiers(1500).high.videoBitrate, 1500);
  assert.equal(qualityTiers(1500).ultra.videoBitrate, 6000);
  assert.equal(qualityTiers(9000).ultra.videoBitrate, 9000);
  assert.equal(qualityTiers(9000).high.videoBitrate, 2000);
});

test('only Ultra allows 60 fps', () => {
  assert.match(plexProfileConstraints('high'), /video.frameRate&value=30/);
  assert.match(plexProfileConstraints('ultra'), /video.frameRate&value=60/);
});
