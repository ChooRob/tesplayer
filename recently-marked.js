// Remembers, for a short while, which items a viewer just marked watched or
// unwatched. A player that is still running keeps reporting its old position,
// which would put the item straight back into Continue Watching (or finish it
// again); those reports are ignored during this window.

export const MARKED_WINDOW_MS = 30_000;

export function createRecentlyMarked({ windowMs = MARKED_WINDOW_MS, now = () => Date.now() } = {}) {
  const marked = new Map();
  const keyOf = (scope, itemId) => `${scope}\0${itemId}`;
  function prune() {
    const cutoff = now() - windowMs;
    for (const [key, at] of marked) if (at <= cutoff) marked.delete(key);
  }
  return {
    mark(scope, itemId) { prune(); marked.set(keyOf(scope, itemId), now()); },
    isRecent(scope, itemId) {
      const at = marked.get(keyOf(scope, itemId));
      return at !== undefined && now() - at < windowMs;
    },
  };
}
