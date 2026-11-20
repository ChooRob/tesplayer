// The # A-Z bar at the edge of a long list: which letters the list has and where each begins, so tapping
// a letter can scroll to that section. Lists are in alphabetical order of a name (an artist's name when a
// list of albums or tracks is ordered by artist), so a letter's section is where the first such name is.

export const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

// A leading "The", "A" or "An" does not count, as in the order Plex and other servers sort by.
const ARTICLE = /^(?:the|an|a)\s+(?=\S)/i;

// The bar letter of a name: A-Z (accents folded), or # for a digit, a symbol or nothing.
// `articles: false` is for a sort name the server has already worked out (Plex leaves "A Taste of Honey" under A).
export function letterOf(text, { articles = true } = {}) {
  const trimmed = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const folded = articles ? trimmed.replace(ARTICLE, '') : trimmed;
  const first = folded.charAt(0).toUpperCase();
  return first >= 'A' && first <= 'Z' ? first : '#';
}

// The name a list is ordered by: an artist's name for albums and tracks listed by artist, else the title.
export function orderName(item, view = null) {
  if (view === 'tracks' || item?.type === 'track') return item.artist || item.showTitle || item.title;
  if (view === 'albums' || item?.type === 'album') return item.showTitle || item.title;
  // The server's own sort name when it gives one, since that is what the list is in the order of.
  return item?.sortTitle || item?.title;
}

// letter -> index of the first item that has it.
export function letterIndex(items, view = null) {
  const first = new Map();
  items.forEach((item, index) => {
    // A sort name from the server is already in the order the list has; a title still has its article to drop.
    const bySortName = item?.sortTitle && orderName(item, view) === item.sortTitle;
    const letter = letterOf(orderName(item, view), { articles: !bySortName });
    if (!first.has(letter)) first.set(letter, index);
  });
  return first;
}

// Where tapping `letter` goes: its own section, else the next letter that has one, else the last
// section there is (a list with nothing from Q on still lands at its end). null for an empty list.
export function targetIndex(index, letter) {
  if (!index.size) return null;
  if (index.has(letter)) return index.get(letter);
  for (const next of LETTERS.slice(LETTERS.indexOf(letter) + 1)) if (index.has(next)) return index.get(next);
  return Math.max(...index.values());
}

// A bar is worth having on a list long enough to scroll through.
export const LETTER_BAR_MIN_ITEMS = 40;
