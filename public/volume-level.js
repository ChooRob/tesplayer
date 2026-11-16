// The viewer's volume, as a multiplier of the original level: 1 is unchanged,
// above 1 boosts it (Canvas playback only; the browser's own video volume stops
// at 1). Kept apart from the page so the limits and storage can be tested.

export const VOLUME_KEY = 'volume';
export const MAX_BOOST = 4;

export function normalizeVolume(value, max = MAX_BOOST) {
  const level = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(max, Math.max(0, level));
}

export function readVolume(storage, max = MAX_BOOST) {
  try {
    const stored = storage?.getItem(VOLUME_KEY);
    return stored === null || stored === undefined ? 1 : normalizeVolume(Number(stored), max);
  } catch { return 1; }
}

export function saveVolume(storage, value) {
  try { storage?.setItem(VOLUME_KEY, String(normalizeVolume(value))); } catch { /* applies for this page only */ }
}
