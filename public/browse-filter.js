// The words typed in the search box, matched against a list of items: every word must appear, in any
// order, in what the item says about itself (its title, artist, album, show or year), ignoring
// case and accents. It works on whatever the screen lists, whatever the source.

const fold = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const FIELDS = ['title', 'artist', 'album', 'showTitle', 'year'];

export const words = query => fold(query).split(/\s+/).filter(Boolean);

export function itemMatches(item, query) {
  const needed = words(query);
  if (!needed.length) return true;
  const text = FIELDS.map(field => fold(item?.[field])).join(' ');
  return needed.every(word => text.includes(word));
}

export function filterItems(items, query) {
  return words(query).length ? items.filter(item => itemMatches(item, query)) : items;
}
