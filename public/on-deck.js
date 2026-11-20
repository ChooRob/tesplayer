// Which episode Play starts at on a show or season, as Plex's own Play button does.

// Begun and not nearly finished: such an item resumes where it was left.
export const isResumable = item => item.viewOffset > 5000 && item.durationMs > 0 && item.viewOffset < item.durationMs - 30000;

// The on-deck episode: one already begun, else the one after the last watched, else the first.
export function onDeckIndex(episodes) {
  const begun = episodes.findIndex(isResumable);
  if (begun >= 0) return begun;
  let lastWatched = -1;
  episodes.forEach((episode, index) => { if (episode.viewCount > 0) lastWatched = index; });
  return lastWatched + 1 < episodes.length ? lastWatched + 1 : 0;
}
