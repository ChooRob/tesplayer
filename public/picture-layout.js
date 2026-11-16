// Where the picture sits in the window: a size (fraction of the window, 0.4 to
// 1) and an offset (fractions of the window width and height) from centered.
// Kept in one place so the player page and its tests agree on the limits.

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 1;
export const PICTURE_KEY = 'picture';
export const CENTERED = Object.freeze({ scale: 1, x: 0, y: 0 });

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// The picture may travel until its edge meets the window's edge, so at full
// size it cannot move and at 50% it can move a quarter window each way.
export function offsetLimit(scale) {
  return Math.max(0, (1 - scale) / 2);
}

export function normalizePicture(value) {
  const input = value && typeof value === 'object' ? value : {};
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, input.scale === undefined ? 1 : finite(input.scale) || 1));
  const limit = offsetLimit(scale);
  const clamp = offset => Math.min(limit, Math.max(-limit, finite(offset))) + 0; // + 0 turns -0 into 0
  return { scale, x: clamp(input.x), y: clamp(input.y) };
}

export function readPicture(storage) {
  try { return normalizePicture(JSON.parse(storage?.getItem(PICTURE_KEY) ?? 'null')); } catch { return { ...CENTERED }; }
}

export function savePicture(storage, picture) {
  try { storage?.setItem(PICTURE_KEY, JSON.stringify(normalizePicture(picture))); } catch { /* applies for this page only */ }
}
