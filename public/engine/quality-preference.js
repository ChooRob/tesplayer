import { QUALITY_LEVELS } from './quality-tiers.js';

// The viewer's quality setting for this browser: Auto, or a fixed tier.
export const QUALITY_STORAGE_KEY = 'freeStuffCrazyPlayer.quality';
export const QUALITY_CHOICES = ['auto', ...QUALITY_LEVELS];
const NAMES = { auto: 'Auto', ultra: 'Ultra', high: 'High', medium: 'Medium', low: 'Low' };

export const normalizeQualityPreference = value => (QUALITY_CHOICES.includes(value) ? value : 'auto');
export function readQualityPreference(storage) {
  try { return normalizeQualityPreference(storage.getItem(QUALITY_STORAGE_KEY)); } catch { return 'auto'; }
}
export const qualityName = value => NAMES[value] || NAMES.auto;

// What the viewer is getting, and whether it is their choice or the player's.
export function describeQuality({ current, preference }) {
  const playing = `Playing at ${qualityName(current)}`;
  if (preference === 'auto') return `${playing}, chosen automatically.`;
  if (preference === current) return `${playing}, as you set.`;
  const lowered = QUALITY_LEVELS.indexOf(current) > QUALITY_LEVELS.indexOf(preference);
  return lowered
    ? `${playing}. Lowered from your ${qualityName(preference)} setting because playback was struggling.`
    : `${playing}. Your setting is ${qualityName(preference)}.`;
}
