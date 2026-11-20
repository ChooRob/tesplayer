// Artist radio: a queue that begins with a track by the artist and carries on with the artist's own
// tracks mixed with tracks by artists like it, so it keeps feeling familiar without being one record.
// It is built from what any source already offers (an artist's tracks, and the artists like it), so it
// works for every source that does.

export const RADIO_SIZE = 40;       // a radio's queue is kept at this many tracks
export const OWN_TRACKS = 14;      // how many of the artist's own tracks go in the mix
export const PER_SIMILAR = 4;      // and how many of each similar artist's

const shuffled = (items, random) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

// `artistTracks`: the artist's tracks. `similarTracks`: one list of tracks per similar artist.
// The first track is one of the artist's own; the rest are mixed, each track once.
// `exclude` is the keys of tracks not to play again (what the radio has already queued).
export function mixRadio({ artistTracks, similarTracks = [], random = Math.random, size = RADIO_SIZE, exclude = [] }) {
  const seen = new Set([...exclude].map(String));
  const fresh = track => track?.ratingKey != null && !seen.has(String(track.ratingKey)) && (seen.add(String(track.ratingKey)), true);

  const own = shuffled(artistTracks, random);
  const first = own.find(fresh);
  const mix = [
    ...own.filter(fresh).slice(0, OWN_TRACKS),
    ...similarTracks.flatMap(tracks => shuffled(tracks, random).filter(fresh).slice(0, PER_SIMILAR)),
  ];
  const rest = shuffled(mix, random).slice(0, Math.max(0, size - (first ? 1 : 0)));
  return first ? [first, ...rest] : rest;
}

// Gathers what a radio is made from, through the routes every page uses, and mixes it. Used to start a
// radio and, later, to keep it going: `exclude` keeps the tracks already queued from coming round again.
export async function gatherRadio({ fetchJson, artistKey, exclude = [], size = RADIO_SIZE, random = Math.random, similarArtists = 8 }) {
  const tracksOf = key => fetchJson(`/api/library/show/${key}/episodes`).then(items => items.filter(item => item.type === 'track')).catch(() => []);
  const artistTracks = await tracksOf(artistKey);
  let similar = [];
  try { similar = (await fetchJson(`/api/library/similar/${artistKey}`)).sections.flatMap(section => section.items).slice(0, similarArtists); } catch { /* from the artist alone */ }
  const similarTracks = await Promise.all(similar.map(item => tracksOf(item.ratingKey)));
  return mixRadio({ artistTracks, similarTracks, random, size, exclude });
}

// A radio is a window that rolls along: the tracks already played go from the front (all but the last few,
// kept so Previous still has somewhere to go) and new ones are added to the end, so it stays RADIO_SIZE long.
export const RADIO_KEEP_PLAYED = 10;
