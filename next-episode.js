// Which episode comes after the one being watched. Specials (season 0) are
// skipped unless the viewer is already in one.
export function nextEpisodeAfter(episodes, currentId) {
  const list = Array.isArray(episodes) ? episodes : [];
  const at = list.findIndex(episode => String(episode.ratingKey) === String(currentId));
  if (at < 0) return null;
  const inSpecials = list[at].season === 0;
  const next = list.slice(at + 1).find(episode => inSpecials || episode.season !== 0);
  if (!next) return null;
  return { ratingKey: String(next.ratingKey), title: next.title ?? '', season: next.season ?? null, episode: next.episode ?? null };
}

// Plex gives a show's key as a path ("/library/metadata/123"); Jellyfin gives the id.
export const showIdFromKey = key => (key ? String(key).split('/').filter(Boolean).pop() || null : null);
