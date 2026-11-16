import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALITY_CHOICES, QUALITY_STORAGE_KEY, describeQuality, normalizeQualityPreference, readQualityPreference } from '../public/engine/quality-preference.js';

test('the choices are Auto, Ultra, High, Medium and Low in that order', () => {
  assert.deepEqual(QUALITY_CHOICES, ['auto', 'ultra', 'high', 'medium', 'low']);
});

test('anything unrecognized means Auto', () => {
  assert.equal(normalizeQualityPreference('enhanced'), 'auto');
  assert.equal(normalizeQualityPreference('ultra'), 'ultra');
  assert.equal(normalizeQualityPreference(null), 'auto');
  assert.equal(normalizeQualityPreference('medium'), 'medium');
});

test('it reads the saved choice and survives unavailable storage', () => {
  assert.equal(readQualityPreference({ getItem: key => (key === QUALITY_STORAGE_KEY ? 'low' : null) }), 'low');
  assert.equal(readQualityPreference({ getItem: () => 'nonsense' }), 'auto');
  assert.equal(readQualityPreference({ getItem() { throw new Error('blocked'); } }), 'auto');
});

test('it says what is playing and who chose it', () => {
  assert.equal(describeQuality({ current: 'medium', preference: 'auto' }), 'Playing at Medium, chosen automatically.');
  assert.equal(describeQuality({ current: 'high', preference: 'high' }), 'Playing at High, as you set.');
  assert.match(describeQuality({ current: 'low', preference: 'high' }), /^Playing at Low\. Lowered from your High setting/);
  assert.match(describeQuality({ current: 'high', preference: 'low' }), /Your setting is Low\./);
});
